/**
 * Live exit loop — monitors open positions and emits exit TradePlans
 * when exit signals fire.
 */

import type { LivePosition, PriceSnap, TradePlan } from "./types.ts";
import type { AppConfig, StrategyConfig } from "./config.ts";
import { evaluateExit } from "./signals.ts";
import type { ExitConfig } from "./signals.ts";
import { getDb, getOpenPositions, updatePositionClose } from "./db.ts";
import { log, traceId } from "./logger.ts";
import { openPositions as openPositionsGauge } from "./metrics.ts";
import { WSOL } from "./dexes.ts";

export class PositionManager {
  readonly positions = new Map<string, LivePosition>();
  private readonly strategyMap: Map<string, StrategyConfig>;
  private readonly plog = log.child({ component: "position-mgr" });

  constructor(config: AppConfig) {
    this.strategyMap = new Map(config.strategies.map((s) => [s.id, s]));
  }

  /** Load open positions from DB on boot, populates the map. */
  loadFromDb(): void {
    const rows = getOpenPositions(getDb());
    for (const row of rows) {
      const pos = rowToLivePosition(row);
      this.positions.set(pos.id, pos);
    }
    openPositionsGauge.set(this.positions.size);
    this.plog.info("loaded open positions from DB", { count: this.positions.size });
  }

  addPosition(pos: LivePosition): void {
    this.positions.set(pos.id, pos);
    openPositionsGauge.set(this.positions.size);
    this.plog.info("position added", { id: pos.id, mint: pos.mint, strategy: pos.strategyId });
  }

  /**
   * Process a price snapshot: evaluate exit signals for matching positions.
   * Returns any exit TradePlans that should be dispatched to TxEngine.
   */
  onPriceSnap(snap: PriceSnap, prevSnaps: PriceSnap[] = []): TradePlan[] {
    const plans: TradePlan[] = [];

    for (const pos of this.positions.values()) {
      if (pos.mint !== snap.mint) continue;
      if (pos.state !== "open") continue;

      // Skip positions without a valid entry price yet (waiting for first snap)
      if (pos.entryPrice <= 0) continue;

      // Look up strategy exit config
      const strat = this.strategyMap.get(pos.strategyId);
      const exitCfg: ExitConfig = strat?.exit ?? {};

      // Update peak price
      if (snap.priceQuotePerBase > pos.peakPrice) {
        pos.peakPrice = snap.priceQuotePerBase;
      }

      // Evaluate exit signals with price history
      const decision = evaluateExit(pos, snap, prevSnaps, exitCfg);

      // Hard upper bound holdSec check (redundant with X3 inside evaluateExit,
      // but kept as safety net for edge cases where evaluateExit returns NoExit
      // due to ordering — e.g. a stop fires before time, but the stop is disabled)
      if (!decision.exit && exitCfg.holdSec !== undefined) {
        const elapsed = (new Date(snap.takenAt).getTime() - new Date(pos.entryAt).getTime()) / 1000;
        if (elapsed >= exitCfg.holdSec) {
          plans.push(buildExitPlan(pos, snap, "exit_full", 1.0, exitCfg, strat));
          continue;
        }
      }

      if (decision.exit) {
        const kind = decision.sellFraction >= 1.0 ? "exit_full" : "exit_partial";
        plans.push(buildExitPlan(pos, snap, kind, decision.sellFraction, exitCfg, strat));
      }
    }

    return plans;
  }

  /** Close a position: update DB and remove from map. */
  closePosition(posId: string, reason: string, sig: string | null): void {
    const pos = this.positions.get(posId);
    if (!pos) {
      this.plog.warn("closePosition called for unknown position", { posId });
      return;
    }

    updatePositionClose(getDb(), posId, {
      peakPrice: pos.peakPrice,
      realisedFrac: pos.realisedFrac,
      realisedSol: pos.realisedSol,
      state: "closed",
      closedAt: new Date().toISOString(),
      closeReason: reason,
      closeSig: sig,
    });

    this.positions.delete(posId);
    openPositionsGauge.set(this.positions.size);
    this.plog.info("position closed", { posId, reason });
  }

  /** Count open positions by strategy. */
  getOpenCountByStrategy(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const pos of this.positions.values()) {
      if (pos.state !== "open") continue;
      counts.set(pos.strategyId, (counts.get(pos.strategyId) ?? 0) + 1);
    }
    return counts;
  }

  close(): void {
    this.plog.info("position manager closed");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert a raw DB row (snake_case) to LivePosition (camelCase). */
function rowToLivePosition(row: Record<string, unknown>): LivePosition {
  return {
    id: row.id as string,
    strategyId: row.strategy_id as string,
    poolSignature: (row.entry_sig as string) ?? "",
    mint: row.mint as string,
    pool: row.pool as string,
    dexKey: (row.dex_key as string) ?? "",
    entrySlot: row.entry_slot as number,
    entryAt: row.opened_at as string,
    entryPrice: row.entry_price as number,
    baselineQuoteReserve: (row.baseline_quote_reserve as number) ?? 0,
    size: row.size_sol as number,
    tokenAmount: (row.token_amount as number) ?? 0,
    peakPrice: row.peak_price as number,
    realisedFrac: row.realised_frac as number,
    realisedSol: row.realised_sol as number,
    state: row.state as "open" | "closing" | "closed",
    openedAt: row.opened_at as string,
    closedAt: (row.closed_at as string) ?? null,
    closeReason: (row.close_reason as string) ?? null,
    closeSig: (row.close_sig as string) ?? null,
    traceId: (row.trace_id as string) ?? "",
  };
}

function buildExitPlan(
  pos: LivePosition,
  _snap: PriceSnap,
  kind: "exit_partial" | "exit_full",
  sellFraction: number,
  exitCfg: ExitConfig,
  strat: StrategyConfig | undefined,
): TradePlan {
  return {
    attemptId: traceId(),
    traceId: pos.traceId,
    strategyId: pos.strategyId,
    mint: pos.mint,
    pool: pos.pool,
    dexKey: pos.dexKey,
    sizeSol: pos.size * sellFraction * (1 - pos.realisedFrac),
    maxSlippageBps: strat?.maxSlippageBps ?? 250,
    computeUnitLimit: 200_000,
    priorityFeeMicroLamports: strat?.maxFeeLamports ?? 100_000,
    exitConfig: {
      ladderRungs: exitCfg.ladderRungs,
      trailPct: exitCfg.trailPct,
      holdSec: exitCfg.holdSec,
      stopPct: exitCfg.stopPct,
      drainPct: exitCfg.drainPct,
      decayN: exitCfg.decayN,
    },
    kind,
    positionId: pos.id,
    inputMint: pos.mint, // Exits sell the token
    outputMint: WSOL,
    createdAt: Date.now(),
  };
}
