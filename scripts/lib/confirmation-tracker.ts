/**
 * Confirmation tracker — state machine that holds pool events waiting for
 * upward price momentum before opening a position.
 *
 * Strategies with `confirmationSnaps` + `confirmationPct` set require price
 * to move up by at least `confirmationPct` within `confirmationSnaps`
 * snapshots after pool detection. Dead/flat pools never confirm, filtering
 * out the vast majority of duds.
 *
 * Flow:
 *   1. mainLoop adds a pending entry via addPending(event, plan, strategy)
 *   2. exitLoop feeds every PriceSnap to onPriceSnap(snap)
 *   3. On confirmation → returns a ConfirmedEntry with final sizing + price
 *   4. Caller opens the position and dispatches to TxEngine
 */

import type { PoolEvent, PriceSnap, TradePlan } from "./types.ts";
import type { Strategy } from "./signals.ts";
import { WSOL } from "./dexes.ts";
import { log } from "./logger.ts";
import { appendJsonl } from "./storage.ts";

const tlog = log.child({ component: "confirmation" });

// ─── Types ──────────────────────────────────────────────────────────

interface PendingEntry {
  mint: string;
  event: PoolEvent;
  plan: TradePlan;
  strategy: Strategy;
  /** Price from first valid snap — set once, used as baseline. */
  basePrice: number;
  /** Wall-clock ms when this pending entry was created. */
  addedAt: number;
  /** Number of price snaps processed since added. */
  snapsSeen: number;
  /** Price at each snap for diagnostics. */
  snapPrices: number[];
  /** Max confirmation window (from strategy). */
  maxSnaps: number;
  /** Min upward price change fraction (from strategy). */
  minChangePct: number;
  /** Require WSOL as quote mint. */
  requireWsol: boolean;
}

export interface ConfirmedEntry {
  event: PoolEvent;
  plan: TradePlan;
  strategy: Strategy;
  /** Entry price at confirmation snap (includes simulated slippage). */
  entryPrice: number;
  /** Raw price from the snap (no slippage). */
  rawPrice: number;
  /** Current quote reserve — used for size cap. */
  quoteReserve: number;
  /** The snap that triggered confirmation. */
  snap: PriceSnap;
  /** Number of snaps it took to confirm. */
  snapCount: number;
}

// ─── Tracker ────────────────────────────────────────────────────────

const PENDING_LOG_PATH = "data/confirmation-pending.jsonl";

export class ConfirmationTracker {
  private readonly pending = new Map<string, PendingEntry>();
  /** Mints that have already been confirmed or rejected — prevents re-entry. */
  private readonly seen = new Set<string>();
  /** Hard cap on pending queue to bound memory. */
  private readonly maxPending: number;

  constructor(maxPending = 200) {
    this.maxPending = maxPending;
  }

  /** Returns true if the strategy requires confirmation. */
  static needsConfirmation(strat: Strategy): boolean {
    return (
      strat.confirmationSnaps !== undefined &&
      strat.confirmationSnaps > 0 &&
      strat.confirmationPct !== undefined &&
      strat.confirmationPct > 0
    );
  }

  /**
   * Register a pool event + trade plan as pending confirmation.
   * Returns false if rejected (duplicate, cap reached, etc).
   */
  addPending(mint: string, event: PoolEvent, plan: TradePlan, strategy: Strategy): boolean {
    if (this.seen.has(mint) || this.pending.has(mint)) return false;
    if (this.pending.size >= this.maxPending) return false;

    this.pending.set(mint, {
      mint,
      event,
      plan,
      strategy,
      basePrice: 0,
      addedAt: Date.now(),
      snapsSeen: 0,
      snapPrices: [],
      maxSnaps: strategy.confirmationSnaps ?? 3,
      minChangePct: strategy.confirmationPct ?? 0.01,
      requireWsol: strategy.requireWsolQuote ?? false,
    });

    tlog.info("pending", {
      mint: mint.slice(0, 8),
      dex: event.dexKey,
      maxSnaps: strategy.confirmationSnaps,
      minPct: `${((strategy.confirmationPct ?? 0.01) * 100).toFixed(1)}%`,
      pending: this.pending.size,
    });

    return true;
  }

  /**
   * Process a price snap against all pending confirmations.
   * Returns confirmed entries ready for position opening.
   */
  onPriceSnap(snap: PriceSnap): ConfirmedEntry[] {
    const entry = this.pending.get(snap.mint);
    if (!entry) return [];

    entry.snapsSeen++;
    entry.snapPrices.push(snap.priceQuotePerBase);

    // Dead snap — no valid price
    if (snap.priceQuotePerBase <= 0) {
      if (entry.snapsSeen >= entry.maxSnaps) {
        this.expire(entry, "no_price");
      }
      return [];
    }

    // WSOL quote check
    if (entry.requireWsol && snap.quoteMint !== WSOL) {
      this.expire(entry, "not_wsol_quote");
      return [];
    }

    // Set base price on first valid snap
    if (entry.basePrice <= 0) {
      entry.basePrice = snap.priceQuotePerBase;
      return []; // Need at least one more snap to compare
    }

    // Check upward momentum
    const change = snap.priceQuotePerBase / entry.basePrice - 1;

    if (change >= entry.minChangePct) {
      // CONFIRMED
      this.pending.delete(snap.mint);
      this.seen.add(snap.mint);

      // Simulated entry slippage based on reserves
      const qr = snap.quoteReserve;
      let size = entry.plan.sizeSol;
      // Cap at 0.5% of reserves for slippage control
      if (qr > 0) {
        size = Math.min(size, Math.max(0.02, qr * 0.005));
      }
      const slippage = qr > 0 ? Math.min(0.2, size / (qr + 1e-9)) : 0;
      const effectiveEntry = snap.priceQuotePerBase * (1 + slippage);

      // Update plan with capped size
      entry.plan.sizeSol = size;

      tlog.info("CONFIRMED", {
        mint: snap.mint.slice(0, 8),
        change: `${(change * 100).toFixed(1)}%`,
        snaps: entry.snapsSeen,
        dex: entry.event.dexKey,
        size: `${size.toFixed(4)} SOL`,
        reserve: `${qr.toFixed(1)} SOL`,
      });

      return [
        {
          event: entry.event,
          plan: entry.plan,
          strategy: entry.strategy,
          entryPrice: effectiveEntry,
          rawPrice: snap.priceQuotePerBase,
          quoteReserve: qr,
          snap,
          snapCount: entry.snapsSeen,
        },
      ];
    }

    // Expired — window exhausted without sufficient momentum
    if (entry.snapsSeen >= entry.maxSnaps) {
      this.expire(entry, "expired", change);
    }

    return [];
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  /** Evict stale seen entries to bound memory (call periodically). */
  evictSeen(maxSize = 5000): void {
    if (this.seen.size <= maxSize) return;
    const iter = this.seen.values();
    const toDelete = this.seen.size - maxSize;
    for (let i = 0; i < toDelete; i++) {
      this.seen.delete(iter.next().value as string);
    }
  }

  // ─── internal ────────────────────────────────────────────────────

  private expire(entry: PendingEntry, outcome: string, lastChange?: number): void {
    this.pending.delete(entry.mint);
    this.seen.add(entry.mint);

    tlog.info("expired", {
      mint: entry.mint.slice(0, 8),
      outcome,
      snaps: entry.snapsSeen,
      basePrice: entry.basePrice,
      lastChange: lastChange !== undefined ? `${(lastChange * 100).toFixed(2)}%` : undefined,
    });

    appendJsonl(PENDING_LOG_PATH, {
      ts: new Date().toISOString(),
      mint: entry.mint,
      dex: entry.event.dexKey,
      outcome,
      basePrice: entry.basePrice,
      snapsSeen: entry.snapsSeen,
      snapPrices: entry.snapPrices,
      lastChange,
    });
  }
}
