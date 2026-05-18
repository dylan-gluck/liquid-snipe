/**
 * Safety checker — validates pool events before trading.
 * Runs 6 parallel checks with per-check timeouts.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import type { PoolEvent, MintEnrichment, SafetyVerdict } from "./types.ts";
import type { AppConfig } from "./config.ts";
import { BURN_ADDRESSES, STABLE_MINTS, WSOL } from "./dexes.ts";
import { log } from "./logger.ts";
import { getDb, upsertMintEnrichment } from "./db.ts";
import { existsSync, readFileSync } from "node:fs";

const CHECK_TIMEOUT_MS = 30;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  data: MintEnrichment;
  expiresAt: number;
}

type CheckResult = { name: string; pass: boolean; reason: string; durationMs: number };

export function loadBlocklist(path = "data/blocklist.json"): Set<string> {
  try {
    if (!existsSync(path)) return new Set();
    const raw = readFileSync(path, "utf-8");
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export class SafetyChecker {
  private readonly conn: Connection;
  private readonly config: AppConfig;
  private readonly mintCache = new Map<string, CacheEntry>();
  private readonly logger = log.child({ component: "safety" });
  private readonly blocklist: Set<string>;

  constructor(connection: Connection, config: AppConfig) {
    this.conn = connection;
    this.config = config;
    this.blocklist = loadBlocklist();
  }

  async evaluate(pool: PoolEvent): Promise<SafetyVerdict> {
    const t0 = performance.now();

    // Pick base mint: first non-stable token
    const baseMint = pool.tokens.find((t) => !STABLE_MINTS.has(t));
    if (!baseMint) {
      return {
        pass: false,
        checks: [
          { name: "no-base-mint", pass: false, reason: "no non-stable token found", durationMs: 0 },
        ],
        totalDurationMs: 0,
        enrichment: null,
      };
    }

    const minSol = this.config.strategies[0]?.minSol ?? 1;

    // Run all 6 checks in parallel with per-check timeouts
    const checks = await Promise.allSettled([
      this.withTimeout("checkMint", () => this.checkMint(baseMint)),
      this.withTimeout("checkLpBurn", () => this.checkLpBurn(pool)),
      this.withTimeout("checkPoolDepth", () => this.checkPoolDepth(pool, minSol)),
      this.withTimeout("checkHoneypot", () => this.checkHoneypot(baseMint)),
      this.withTimeout("checkDeployer", () => this.checkDeployer(pool)),
      this.withTimeout("checkMintAuthority", () => this.checkMintAuthority(baseMint)),
    ]);

    const results: CheckResult[] = checks.map((r, i) => {
      const names = [
        "checkMint",
        "checkLpBurn",
        "checkPoolDepth",
        "checkHoneypot",
        "checkDeployer",
        "checkMintAuthority",
      ];
      if (r.status === "fulfilled") return r.value;
      return {
        name: names[i]!,
        pass: false,
        reason: `rejected: ${String(r.reason)}`,
        durationMs: CHECK_TIMEOUT_MS,
      };
    });

    const enrichment = this.mintCache.get(baseMint)?.data ?? null;
    const totalDurationMs = performance.now() - t0;

    const verdict: SafetyVerdict = {
      pass: results.every((c) => c.pass),
      checks: results,
      totalDurationMs,
      enrichment,
    };

    this.logger.info("safety evaluation complete", {
      mint: baseMint,
      pass: verdict.pass,
      totalDurationMs: Math.round(totalDurationMs),
    });

    return verdict;
  }

  // ─── Per-check timeout wrapper ────────────────────────────────────

  private async withTimeout(name: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    try {
      const result = await Promise.race([
        fn(),
        new Promise<CheckResult>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
        }),
      ]);
      return result;
    } catch {
      return { name, pass: false, reason: "check timed out", durationMs: CHECK_TIMEOUT_MS };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Check 1: Mint data ───────────────────────────────────────────

  private async checkMint(mint: string): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkMint";

    try {
      const enrichment = await this.fetchMintData(mint);
      const pass = enrichment.mintAuthority === null && enrichment.freezeAuthority === null;
      const reasons: string[] = [];
      if (enrichment.mintAuthority !== null) reasons.push("mint authority active");
      if (enrichment.freezeAuthority !== null) reasons.push("freeze authority active");
      return {
        name,
        pass,
        reason: pass ? "authorities renounced" : reasons.join("; "),
        durationMs: performance.now() - t0,
      };
    } catch (err) {
      return {
        name,
        pass: false,
        reason: `rpc error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - t0,
      };
    }
  }

  // ─── Check 2: LP burn ─────────────────────────────────────────────

  private async checkLpBurn(pool: PoolEvent): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkLpBurn";

    // Try to infer LP mint from programAccounts — typically the last account for Raydium
    const lpMint =
      pool.programAccounts.length > 0
        ? pool.programAccounts[pool.programAccounts.length - 1]
        : undefined;

    if (!lpMint) {
      return { name, pass: true, reason: "lp-mint-unknown", durationMs: performance.now() - t0 };
    }

    try {
      const largest = await this.conn.getTokenLargestAccounts(new PublicKey(lpMint));
      const accounts = largest.value;
      if (accounts.length === 0) {
        return {
          name,
          pass: true,
          reason: "no lp token accounts found",
          durationMs: performance.now() - t0,
        };
      }

      const totalRaw = accounts.reduce((sum, a) => sum + Number(a.amount), 0);
      if (totalRaw === 0) {
        return {
          name,
          pass: true,
          reason: "zero lp supply in top accounts",
          durationMs: performance.now() - t0,
        };
      }

      // Check each account's owner to see if it's a burn address
      // We need to resolve the account owners
      const ownerChecks = await Promise.allSettled(
        accounts.map((a) => this.conn.getParsedAccountInfo(new PublicKey(a.address))),
      );

      let burnedAmount = 0;
      for (let i = 0; i < accounts.length; i++) {
        const result = ownerChecks[i];
        if (result?.status === "fulfilled" && result.value.value) {
          const parsed = result.value.value;
          // For token accounts, owner info is in parsed data
          if ("parsed" in (parsed.data as Record<string, unknown>)) {
            const info = (parsed.data as { parsed: { info: { owner: string } } }).parsed.info;
            if (BURN_ADDRESSES.has(info.owner)) {
              burnedAmount += Number(accounts[i]!.amount);
            }
          }
        }
      }

      const burnPct = burnedAmount / totalRaw;
      const pass = burnPct >= 0.95;
      return {
        name,
        pass,
        reason: pass
          ? `${(burnPct * 100).toFixed(1)}% burned`
          : `only ${(burnPct * 100).toFixed(1)}% burned (<95%)`,
        durationMs: performance.now() - t0,
      };
    } catch (err) {
      return {
        name,
        pass: false,
        reason: `rpc error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - t0,
      };
    }
  }

  // ─── Check 3: Pool depth ──────────────────────────────────────────

  private async checkPoolDepth(pool: PoolEvent, minSol: number): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkPoolDepth";
    const pass = pool.solValue >= minSol;
    return {
      name,
      pass,
      reason: pass
        ? `pool depth ${pool.solValue.toFixed(2)} SOL >= ${minSol}`
        : `pool depth ${pool.solValue.toFixed(2)} SOL < ${minSol} minimum`,
      durationMs: performance.now() - t0,
    };
  }

  // ─── Check 4: Honeypot ────────────────────────────────────────────

  private async checkHoneypot(mint: string): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkHoneypot";
    const jupUrl = this.config.jupiter?.apiUrl ?? "https://quote-api.jup.ag/v6";

    try {
      // Forward quote: WSOL → mint
      const fwdResp = await fetch(
        `${jupUrl}/quote?inputMint=${WSOL}&outputMint=${mint}&amount=100000000&slippageBps=500`,
      );
      if (!fwdResp.ok) {
        return {
          name,
          pass: false,
          reason: "honeypot-check-unavailable",
          durationMs: performance.now() - t0,
        };
      }
      const fwd = (await fwdResp.json()) as { outAmount?: string; priceImpactPct?: string };
      if (!fwd.outAmount) {
        return {
          name,
          pass: false,
          reason: "no forward quote available",
          durationMs: performance.now() - t0,
        };
      }

      const fwdImpact = parseFloat(fwd.priceImpactPct ?? "0");
      if (Math.abs(fwdImpact) > 10) {
        return {
          name,
          pass: false,
          reason: `forward price impact ${fwdImpact.toFixed(1)}% > 10%`,
          durationMs: performance.now() - t0,
        };
      }

      // Reverse quote: mint → WSOL
      const revResp = await fetch(
        `${jupUrl}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${fwd.outAmount}&slippageBps=500`,
      );
      if (!revResp.ok) {
        return {
          name,
          pass: false,
          reason: "honeypot-check-unavailable",
          durationMs: performance.now() - t0,
        };
      }
      const rev = (await revResp.json()) as { priceImpactPct?: string };
      const revImpact = parseFloat(rev.priceImpactPct ?? "0");
      if (Math.abs(revImpact) > 10) {
        return {
          name,
          pass: false,
          reason: `reverse price impact ${revImpact.toFixed(1)}% > 10%`,
          durationMs: performance.now() - t0,
        };
      }

      return {
        name,
        pass: true,
        reason: "round-trip quote OK",
        durationMs: performance.now() - t0,
      };
    } catch {
      return {
        name,
        pass: false,
        reason: "honeypot-check-unavailable",
        durationMs: performance.now() - t0,
      };
    }
  }

  // ─── Check 5: Deployer blocklist ──────────────────────────────────

  private async checkDeployer(pool: PoolEvent): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkDeployer";

    const signer = pool.signer;
    if (!signer) {
      return {
        name,
        pass: true,
        reason: "no signer available",
        durationMs: performance.now() - t0,
      };
    }

    if (this.blocklist.has(signer)) {
      return {
        name,
        pass: false,
        reason: "signer on blocklist",
        durationMs: performance.now() - t0,
      };
    }

    try {
      const sigs = await this.conn.getSignaturesForAddress(new PublicKey(signer), { limit: 50 });
      // Count how many of these are token-related (heuristic: all recent sigs)
      const priorLaunches = sigs.length;

      return {
        name,
        pass: true,
        reason: `deployer has ${priorLaunches} recent txns`,
        durationMs: performance.now() - t0,
      };
    } catch (err) {
      return {
        name,
        pass: false,
        reason: `rpc error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - t0,
      };
    }
  }

  // ─── Check 6: Mint authority renounced ────────────────────────────

  private async checkMintAuthority(mint: string): Promise<CheckResult> {
    const t0 = performance.now();
    const name = "checkMintAuthority";

    try {
      const enrichment = await this.fetchMintData(mint);
      const pass = enrichment.mintAuthority === null;
      return {
        name,
        pass,
        reason: pass
          ? "mint authority renounced"
          : `mint authority active: ${enrichment.mintAuthority}`,
        durationMs: performance.now() - t0,
      };
    } catch (err) {
      return {
        name,
        pass: false,
        reason: `rpc error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - t0,
      };
    }
  }

  // ─── Shared mint data fetcher with cache + DB persistence ─────────

  private async fetchMintData(mint: string): Promise<MintEnrichment> {
    const now = Date.now();
    const cached = this.mintCache.get(mint);
    if (cached && cached.expiresAt > now) return cached.data;

    const mintInfo = await getMint(this.conn, new PublicKey(mint));

    const enrichment: MintEnrichment = {
      mint,
      fetchedAt: new Date().toISOString(),
      decimals: mintInfo.decimals,
      supply: Number(mintInfo.supply),
      mintAuthority: mintInfo.mintAuthority?.toBase58() ?? null,
      freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? null,
      top10Concentration: 0,
      lpBurnedOrLocked: null,
      deployerPriorLaunches: null,
      deployer: null,
      notes: [],
    };

    this.mintCache.set(mint, { data: enrichment, expiresAt: now + CACHE_TTL_MS });

    // Persist to DB
    try {
      const db = getDb();
      upsertMintEnrichment(db, {
        mint: enrichment.mint,
        fetchedAt: enrichment.fetchedAt,
        mintAuth: enrichment.mintAuthority,
        freezeAuth: enrichment.freezeAuthority,
        decimals: enrichment.decimals,
        supply: enrichment.supply,
        deployer: enrichment.deployer,
        top10: enrichment.top10Concentration,
        lpBurned: enrichment.lpBurnedOrLocked,
        expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
      });
    } catch (err) {
      this.logger.warn("failed to persist mint enrichment to DB", { mint, err: String(err) });
    }

    return enrichment;
  }
}
