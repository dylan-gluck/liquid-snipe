/**
 * Live price feed — polls on-chain reserve accounts and yields PriceSnap.
 *
 * Uses getMultipleParsedAccounts to read SPL token vault balances correctly
 * (uiAmount from parsed token data, NOT raw lamports).
 *
 * On subscribe, vault candidates (programAccounts from the pool event) are
 * stored. On the first poll that touches a subscription, we resolve which
 * accounts are actually the base/quote SPL token vaults by scanning for
 * parsed token accounts matching the expected mints.
 *
 * Every snapshot is persisted to data/prices.jsonl for backtest consumption.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { PriceSnap } from "./types.ts";
import { STABLE_MINTS, WSOL } from "./dexes.ts";
import { appendJsonl } from "./storage.ts";
import { log } from "./logger.ts";

/** Shape of a parsed SPL token account from getMultipleParsedAccounts. */
interface ParsedTokenAccount {
  data: {
    parsed: {
      info: {
        mint: string;
        tokenAmount: {
          uiAmount: number | null;
        };
      };
      type: string;
    };
    program: string;
  };
}

function isParsedTokenAccount(v: unknown): v is ParsedTokenAccount {
  if (!v || typeof v !== "object") return false;
  const data = (v as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return false;
  return (parsed as { type?: string }).type === "account";
}

interface PoolSubscription {
  mint: string;
  pool: string;
  dexKey: string;
  /** Raw candidate accounts from the pool event — resolved to vaults on first poll. */
  candidates: PublicKey[];
  /** Resolved vault addresses. null until vault resolution succeeds. */
  baseVault: PublicKey | null;
  quoteVault: PublicKey | null;
  quoteMint: string;
  /** Set to true once vault resolution has been attempted (prevents retrying every poll). */
  resolved: boolean;
  /** Epoch ms when this subscription expires — prevents unbounded growth. */
  expiresAt: number;
}

/** Default subscription TTL: 30 minutes. Covers the full pump/dump cycle. */
const SUB_TTL_MS = 30 * 60 * 1000;

const PRICES_PATH = "data/prices.jsonl";

export class PriceFeed {
  private readonly conn: Connection;
  private readonly subs = new Map<string, PoolSubscription>();
  private readonly plog = log.child({ component: "price-feed" });
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  /** Pending snapshots waiting to be consumed by the async iterator. */
  private buffer: PriceSnap[] = [];
  private waiter: ((value: void) => void) | null = null;

  /** Poll interval in ms. Conservative for free-tier Helius (10 req/s). */
  private readonly pollIntervalMs: number;

  constructor(connection: Connection, pollIntervalMs = 5_000) {
    this.conn = connection;
    this.pollIntervalMs = pollIntervalMs;
  }

  subscribe(mint: string, pool: string, dexKey: string, programAccounts: string[]): void {
    if (this.subs.has(mint)) return; // already watching
    this.subs.set(mint, {
      mint,
      pool,
      dexKey,
      // Take first 16 candidates — vaults are always among early accounts
      candidates: programAccounts.slice(0, 16).map((a) => new PublicKey(a)),
      baseVault: null,
      quoteVault: null,
      quoteMint: WSOL,
      resolved: false,
      expiresAt: Date.now() + SUB_TTL_MS,
    });
    this.plog.info("subscribed", { mint: mint.slice(0, 12), pool: pool.slice(0, 12), dexKey });
    this.ensurePolling();
  }

  unsubscribe(mint: string): void {
    this.subs.delete(mint);
    this.plog.info("unsubscribed", { mint: mint.slice(0, 12) });
    if (this.subs.size === 0) this.stopPolling();
  }

  async *snapshots(): AsyncGenerator<PriceSnap> {
    while (!this.closed) {
      if (this.buffer.length > 0) {
        const batch = this.buffer;
        this.buffer = [];
        for (const snap of batch) {
          yield snap;
        }
      } else {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopPolling();
    this.waiter?.();
    this.waiter = null;
  }

  // ─── internal ────────────────────────────────────────────────────

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resolve which of the candidate accounts are the actual base (mint) and
   * quote (WSOL/USDC/USDT) SPL token vaults.
   */
  private async resolveVaults(sub: PoolSubscription): Promise<void> {
    if (sub.candidates.length === 0) {
      sub.resolved = true;
      return;
    }

    let infos;
    try {
      infos = await this.conn.getMultipleParsedAccounts(sub.candidates, {
        commitment: "confirmed",
      });
    } catch (err) {
      this.plog.warn("vault resolution failed", {
        mint: sub.mint.slice(0, 12),
        error: (err as Error).message,
      });
      return;
    }

    sub.resolved = true;

    // Two-pass: first look for WSOL specifically (preferred quote for meme coins),
    // then fall back to any stable. This prevents USDC token accounts in
    // pumpfun/pumpswap program accounts from being picked over WSOL vaults.
    for (let i = 0; i < infos.value.length; i++) {
      const info = infos.value[i];
      if (!info || !isParsedTokenAccount(info)) continue;
      const m = info.data.parsed.info.mint;
      if (m === sub.mint && !sub.baseVault) {
        sub.baseVault = sub.candidates[i]!;
      } else if (m === WSOL && !sub.quoteVault) {
        sub.quoteVault = sub.candidates[i]!;
        sub.quoteMint = WSOL;
      }
    }
    // Fallback: if no WSOL vault found, accept any stable
    if (!sub.quoteVault) {
      for (let i = 0; i < infos.value.length; i++) {
        const info = infos.value[i];
        if (!info || !isParsedTokenAccount(info)) continue;
        const m = info.data.parsed.info.mint;
        if (STABLE_MINTS.has(m) && m !== sub.mint) {
          sub.quoteVault = sub.candidates[i]!;
          sub.quoteMint = m;
          break;
        }
      }
    }

    if (sub.baseVault && sub.quoteVault) {
      this.plog.info("vaults resolved", {
        mint: sub.mint.slice(0, 12),
        base: sub.baseVault.toString().slice(0, 12),
        quote: sub.quoteVault.toString().slice(0, 12),
      });
    }
  }

  private async poll(): Promise<void> {
    if (this.subs.size === 0) return;

    // Evict expired subscriptions
    const now = Date.now();
    for (const [mint, sub] of this.subs) {
      if (sub.expiresAt < now) {
        this.subs.delete(mint);
      }
    }
    if (this.subs.size === 0) {
      this.stopPolling();
      return;
    }

    const entries = Array.from(this.subs.values());

    // Resolve vaults for unresolved subscriptions — max 2 per poll to limit RPC pressure
    let resolved = 0;
    for (const sub of entries) {
      if (!sub.resolved && resolved < 2) {
        await this.resolveVaults(sub);
        resolved++;
      }
    }

    // Collect resolved vault pairs for batch read
    const readableSubs: PoolSubscription[] = [];
    const allKeys: PublicKey[] = [];
    for (const sub of entries) {
      if (!sub.baseVault || !sub.quoteVault) continue;
      readableSubs.push(sub);
      allKeys.push(sub.baseVault, sub.quoteVault);
    }

    if (allKeys.length === 0) return;

    let result;
    try {
      result = await this.conn.getMultipleParsedAccounts(allKeys, { commitment: "confirmed" });
    } catch (err) {
      this.plog.warn("poll failed", { error: (err as Error).message });
      return;
    }

    const nowIso = new Date().toISOString();
    const slot = result.context.slot;

    for (let si = 0; si < readableSubs.length; si++) {
      const sub = readableSubs[si]!;
      const baseInfo = result.value[si * 2];
      const quoteInfo = result.value[si * 2 + 1];

      if (!baseInfo || !quoteInfo) continue;
      if (!isParsedTokenAccount(baseInfo) || !isParsedTokenAccount(quoteInfo)) continue;

      const baseReserve = baseInfo.data.parsed.info.tokenAmount.uiAmount ?? 0;
      const quoteReserve = quoteInfo.data.parsed.info.tokenAmount.uiAmount ?? 0;
      if (baseReserve <= 0) continue;

      const snap: PriceSnap = {
        takenAt: nowIso,
        slot,
        mint: sub.mint,
        pool: sub.baseVault!.toString(),
        dexKey: sub.dexKey,
        baseReserve,
        quoteReserve,
        priceQuotePerBase: quoteReserve / baseReserve,
        quoteMint: sub.quoteMint,
      };

      // Persist for backtest consumption
      appendJsonl<PriceSnap>(PRICES_PATH, snap);

      // Buffer for the exit loop consumer
      this.buffer.push(snap);
    }

    // Wake the async iterator consumer
    if (this.buffer.length > 0) {
      this.waiter?.();
      this.waiter = null;
    }
  }
}
