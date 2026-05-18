#!/usr/bin/env bun
/**
 * enrich-pools.ts
 *
 * Reads data/pools.jsonl, picks the most "interesting" non-stable token
 * mint per event, and writes data/enrich/<mint>.json with the data the
 * entry signals need:
 *
 *   - mint authority / freeze authority      (E3 — mint sanity)
 *   - decimals + total supply
 *   - top-10 holder concentration            (proxy for fairness)
 *   - lp burned / locked heuristic           (E4 — LP locked)
 *   - deployer prior-launch count            (E6 — deployer reputation)
 *
 * Enrichment is one-shot: if data/enrich/<mint>.json already exists we
 * skip unless --force is passed. This is intentional — token state we
 * care about (authority renounce, holder dist) is usually fixed in the
 * first few slots after deploy. For tokens we plan to actively trade,
 * snapshot-prices.ts handles ongoing state.
 *
 * Usage:
 *   bun scripts/enrich-pools.ts                                # enrich every new mint
 *   bun scripts/enrich-pools.ts --in data/pools.jsonl --out data/enrich
 *   bun scripts/enrich-pools.ts --force                        # re-enrich existing
 *   bun scripts/enrich-pools.ts --limit 25                     # process newest N only
 *   bun scripts/enrich-pools.ts --concurrency 4                # rpc concurrency
 *   bun scripts/enrich-pools.ts --rpc <https>                  # paid RPC
 */

import { PublicKey } from "@solana/web3.js";
import { BURN_ADDRESSES, STABLE_MINTS } from "./lib/dexes.ts";
import { getFlag, getInt, hasFlag, makeConnection, parseRpcArgs } from "./lib/cli.ts";
import { ANSI, color, shortKey, ts } from "./lib/format.ts";
import { readJsonl, writeJson } from "./lib/storage.ts";
import type { MintEnrichment, PoolEvent } from "./lib/types.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface ParsedMintAccount {
  data: {
    parsed: {
      info: {
        decimals: number;
        supply: string;
        mintAuthority: string | null;
        freezeAuthority: string | null;
        isInitialized: boolean;
      };
      type: string;
    };
    program: string;
  };
}

function isParsedMint(v: unknown): v is ParsedMintAccount {
  if (!v || typeof v !== "object") return false;
  const data = (v as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return false;
  return (parsed as { type?: string }).type === "mint";
}

/**
 * Pick the most likely "subject" mint for a PoolEvent. For tokens[0] in a
 * captured event we already discard stables in computeLiquidity, but be
 * defensive in case future captures change.
 */
function pickMint(pool: PoolEvent): string | null {
  for (const t of pool.tokens) {
    if (!STABLE_MINTS.has(t)) return t;
  }
  return null;
}

async function enrichOne(
  connection: ReturnType<typeof makeConnection>,
  pool: PoolEvent,
  mint: string,
  deployerCache: Map<string, number>,
): Promise<MintEnrichment> {
  const notes: string[] = [];
  const out: MintEnrichment = {
    mint,
    fetchedAt: new Date().toISOString(),
    decimals: 0,
    supply: 0,
    mintAuthority: null,
    freezeAuthority: null,
    top10Concentration: 0,
    lpBurnedOrLocked: null,
    deployerPriorLaunches: null,
    deployer: pool.signer,
    notes,
  };

  // --- mint info -----------------------------------------------------
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const value = info.value;
    if (value && "data" in value && isParsedMint(value)) {
      const m = value.data.parsed.info;
      out.decimals = m.decimals;
      out.supply = Number(m.supply) / 10 ** m.decimals;
      out.mintAuthority = m.mintAuthority;
      out.freezeAuthority = m.freezeAuthority;
    } else {
      notes.push("mint-info: not-a-parsed-mint");
    }
  } catch (e) {
    notes.push(`mint-info: ${(e as Error).message}`);
  }

  // --- holder concentration -----------------------------------------
  try {
    const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
    let topSum = 0;
    let i = 0;
    for (const acc of largest.value) {
      if (i++ >= 10) break;
      topSum += Number(acc.uiAmount ?? 0);
    }
    if (out.supply > 0) {
      out.top10Concentration = Math.min(1, topSum / out.supply);
    }
    // Heuristic LP burn detection: any of the top accounts holding > 30 %
    // of supply is owned by a burn address?
    if (largest.value[0]) {
      const topAcc = largest.value[0];
      // address field present in v1.98 of web3.js: getTokenLargestAccounts
      // returns address as PublicKey on each entry.
      const ownerAddr = topAcc.address?.toString();
      if (ownerAddr && BURN_ADDRESSES.has(ownerAddr)) {
        out.lpBurnedOrLocked = true;
        notes.push(`lp-burn: top-holder-is-burn (${shortKey(ownerAddr)})`);
      }
    }
  } catch (e) {
    notes.push(`holders: ${(e as Error).message}`);
  }

  // --- deployer history --------------------------------------------
  // Cap at 50 sigs; only an estimate of "has this wallet launched things
  // before?". Cache per-deployer so repeat enrichments don't refetch.
  if (pool.signer) {
    const cached = deployerCache.get(pool.signer);
    if (cached !== undefined) {
      out.deployerPriorLaunches = cached;
    } else {
      try {
        const sigs = await connection.getSignaturesForAddress(new PublicKey(pool.signer), {
          limit: 50,
        });
        const prior = Math.max(0, sigs.length - 1);
        out.deployerPriorLaunches = prior;
        deployerCache.set(pool.signer, prior);
      } catch (e) {
        notes.push(`deployer: ${(e as Error).message}`);
      }
    }
  }

  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const inPath = getFlag(argv, "--in") || "data/pools.jsonl";
  const outDir = getFlag(argv, "--out") || "data/enrich";
  const force = hasFlag(argv, "--force");
  const limit = getInt(argv, "--limit", 0);
  const concurrency = Math.max(1, getInt(argv, "--concurrency", 4));
  const rpc = parseRpcArgs(argv);
  const connection = makeConnection(rpc);
  const useColor = !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY);

  const pools = readJsonl<PoolEvent>(inPath);
  if (pools.length === 0) {
    console.error(`[${ts()}] no records in ${inPath}`);
    process.exit(1);
  }

  // Dedupe by mint, prefer the earliest capture per mint (that's the
  // "first liquidity" record we care about for E1).
  const byMint = new Map<string, PoolEvent>();
  for (const p of pools) {
    const m = pickMint(p);
    if (!m) continue;
    const existing = byMint.get(m);
    if (!existing || p.slot < existing.slot) byMint.set(m, p);
  }

  let queue = [...byMint.entries()];
  if (limit > 0) queue = queue.slice(-limit);
  console.log(
    color(
      useColor,
      ANSI.dim,
      `[${ts()}] enriching ${queue.length} mints, concurrency=${concurrency}, out=${outDir}`,
    ),
  );

  const deployerCache = new Map<string, number>();
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      const [mint, pool] = next;
      const outPath = join(outDir, `${mint}.json`);
      if (!force && existsSync(outPath)) {
        skipped++;
        continue;
      }
      try {
        const enriched = await enrichOne(connection, pool, mint, deployerCache);
        writeJson(outPath, enriched);
        processed++;
        if (processed % 5 === 0) {
          console.log(
            color(
              useColor,
              ANSI.dim,
              `[${ts()}] enriched ${processed}/${queue.length + processed + skipped} (skip=${skipped})`,
            ),
          );
        }
        console.log(
          color(useColor, ANSI.dim, "  ") +
            `${shortKey(mint)}  authority=${enriched.mintAuthority ? "set" : "null"}  freeze=${enriched.freezeAuthority ? "set" : "null"}  top10=${(enriched.top10Concentration * 100).toFixed(1)}%  prior=${enriched.deployerPriorLaunches ?? "?"}`,
        );
      } catch (e) {
        errors.push(`${mint}: ${(e as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`[${ts()}] done: enriched=${processed} skipped=${skipped} errors=${errors.length}`);
  for (const err of errors.slice(0, 5)) console.error(`  ${err}`);
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
