/**
 * Pre-trade and post-trade risk guards. Reads/writes risk_state table,
 * enforces daily loss limits, sim failure circuit breakers, and halt state.
 */

import type { RiskConfig } from "./config.ts";
import { getDb, getRiskState, upsertRiskState, kvGet, kvSet } from "./db.ts";
import { log } from "./logger.ts";
import { dailyPnlSol } from "./metrics.ts";

const HALTED_KEY = "halted";

export class RiskGuard {
  private readonly config: RiskConfig;
  private readonly rlog = log.child({ component: "risk-guard" });

  constructor(config: RiskConfig) {
    this.config = config;
  }

  /**
   * Pre-trade check. Returns allowed/blocked with reason.
   */
  preTrade(
    strategyId: string,
    sizeSol: number,
    rpcHealthy: boolean,
  ): { allowed: boolean; reason?: string } {
    const db = getDb();

    // Check halt state
    if (kvGet(db, HALTED_KEY) !== null) {
      return { allowed: false, reason: "system halted via kill switch" };
    }

    // Check RPC health
    if (!rpcHealthy) {
      return { allowed: false, reason: "RPC unhealthy" };
    }

    const today = this.getTodayDate();
    const state = getRiskState(db, today);

    // Check daily P&L limit
    if (state && state.pnlSol <= -this.config.dailyMaxLossSol) {
      return {
        allowed: false,
        reason: `daily loss limit reached: ${state.pnlSol.toFixed(4)} SOL (max -${this.config.dailyMaxLossSol})`,
      };
    }

    // Check sim failure circuit breaker
    if (state && state.simFailures >= this.config.maxSimFailures) {
      return {
        allowed: false,
        reason: `sim failure limit reached: ${state.simFailures} (max ${this.config.maxSimFailures})`,
      };
    }

    // Check per-block fee cap (sizeSol as proxy for fee spend)
    if (sizeSol > this.config.perBlockCapSol) {
      return {
        allowed: false,
        reason: `size ${sizeSol} exceeds per-block cap ${this.config.perBlockCapSol}`,
      };
    }

    this.rlog.debug("pre-trade passed", { strategyId, sizeSol });
    return { allowed: true };
  }

  /**
   * Post-trade bookkeeping: update daily P&L + sim failure counter.
   */
  postTrade(pnlSol: number, simFailed: boolean): void {
    const db = getDb();
    const today = this.getTodayDate();
    const state = getRiskState(db, today);

    const currentPnl = (state?.pnlSol ?? 0) + pnlSol;
    const simFailures = simFailed ? (state?.simFailures ?? 0) + 1 : 0;

    upsertRiskState(db, today, currentPnl, simFailures);
    dailyPnlSol.set(currentPnl);

    this.rlog.info("post-trade updated", { pnlSol, currentPnl, simFailures, today });
  }

  /** Trip the circuit breaker — halts all trading. */
  tripCircuitBreaker(reason: string): void {
    const db = getDb();
    kvSet(db, HALTED_KEY, reason);
    this.rlog.error("CIRCUIT BREAKER TRIPPED — trading halted", { reason });
  }

  /** Reset the circuit breaker — resumes trading. */
  resetCircuitBreaker(): void {
    const db = getDb();
    db.query("DELETE FROM kv WHERE key = ?").run(HALTED_KEY);
    this.rlog.info("circuit breaker reset — trading resumed");
  }

  /** Check if the system is halted. */
  isHalted(): boolean {
    return kvGet(getDb(), HALTED_KEY) !== null;
  }

  /** Returns today's date as YYYY-MM-DD. */
  getTodayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
