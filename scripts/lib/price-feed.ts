/**
 * Live price feed — polls on-chain reserve accounts and yields PriceSnap.
 *
 * Primary mode: 1Hz polling via getMultipleAccountsInfo. WebSocket
 * accountSubscribe is an optional enhancement that can be layered later.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { PriceSnap } from "./types.ts";
import { log } from "./logger.ts";

interface PoolSubscription {
  mint: string;
  pool: string;
  dexKey: string;
  vaultAccounts: PublicKey[];
}

export class PriceFeed {
  private readonly conn: Connection;
  private readonly subs = new Map<string, PoolSubscription>();
  private readonly log = log.child({ component: "price-feed" });
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  /** Pending snapshots waiting to be consumed by the async iterator. */
  private buffer: PriceSnap[] = [];
  private waiter: ((value: void) => void) | null = null;

  constructor(connection: Connection) {
    this.conn = connection;
  }

  subscribe(mint: string, pool: string, dexKey: string, vaultAccounts: string[]): void {
    this.subs.set(mint, {
      mint,
      pool,
      dexKey,
      vaultAccounts: vaultAccounts.map((a) => new PublicKey(a)),
    });
    this.log.info("subscribed", { mint, pool, dexKey, vaults: vaultAccounts.length });
    this.ensurePolling();
  }

  unsubscribe(mint: string): void {
    this.subs.delete(mint);
    this.log.info("unsubscribed", { mint });
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
    // Unblock any waiting consumer
    this.waiter?.();
    this.waiter = null;
  }

  // ─── internal ────────────────────────────────────────────────────

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.subs.size === 0) return;

    // Collect all vault accounts across all subscriptions
    const entries = Array.from(this.subs.values());
    const allKeys: PublicKey[] = [];
    const keyIndex: Array<{ subIdx: number; vaultIdx: number }> = [];
    for (let si = 0; si < entries.length; si++) {
      const sub = entries[si]!;
      for (let vi = 0; vi < sub.vaultAccounts.length; vi++) {
        allKeys.push(sub.vaultAccounts[vi]!);
        keyIndex.push({ subIdx: si, vaultIdx: vi });
      }
    }

    let accounts;
    try {
      accounts = await this.conn.getMultipleAccountsInfo(allKeys);
    } catch (err) {
      this.log.warn("poll failed", { err });
      return;
    }

    const now = new Date().toISOString();

    for (const sub of entries) {
      // Gather reserves for this subscription
      const reserves: number[] = [];
      for (let vi = 0; vi < sub.vaultAccounts.length; vi++) {
        const globalIdx = keyIndex.findIndex((k) => entries[k.subIdx] === sub && k.vaultIdx === vi);
        const acct = globalIdx >= 0 ? (accounts[globalIdx] ?? null) : null;
        if (acct) {
          // Raw lamports → SOL (works for SOL vaults; token vaults
          // would need SPL token account parsing — acceptable
          // approximation for phase 5 POC)
          reserves.push(Number(acct.lamports) / 1e9);
        } else {
          reserves.push(0);
        }
      }

      // Need at least 2 reserves (base + quote vaults) to compute price
      if (reserves.length < 2) continue;

      const baseReserve = reserves[0]!;
      const quoteReserve = reserves[1]!;
      if (baseReserve <= 0) continue;

      const snap: PriceSnap = {
        takenAt: now,
        slot: 0, // We don't have slot from getMultipleAccountsInfo context
        mint: sub.mint,
        pool: sub.pool,
        dexKey: sub.dexKey,
        baseReserve,
        quoteReserve,
        priceQuotePerBase: quoteReserve / baseReserve,
        quoteMint: "So11111111111111111111111111111111111111112",
      };

      this.buffer.push(snap);
    }

    // Wake the async iterator consumer
    if (this.buffer.length > 0) {
      this.waiter?.();
      this.waiter = null;
    }
  }
}
