/**
 * Decision engine — evaluates pool events against enabled strategies
 * and produces TradePlan entries for the tx-engine.
 */

import type {
  PoolEvent,
  MintEnrichment,
  DecisionOutcome,
  TradePlan,
  SafetyVerdict,
} from "./types.ts";
import type { AppConfig, StrategyConfig } from "./config.ts";
import { evaluateEntry, type EntryConfig } from "./signals.ts";
import { STABLE_MINTS, WSOL } from "./dexes.ts";
import { log, traceId } from "./logger.ts";
import { detectToDecisionMs } from "./metrics.ts";

const dlog = log.child({ component: "decision" });

export class DecisionEngine {
  private readonly strategies: StrategyConfig[];

  constructor(config: AppConfig) {
    this.strategies = config.strategies.filter((s) => s.enabled);
    dlog.info("loaded enabled strategies", { count: this.strategies.length });
  }

  evaluate(
    pool: PoolEvent,
    enrichment: MintEnrichment | null,
    safety: SafetyVerdict,
    openPositionCounts: Map<string, number>,
  ): DecisionOutcome[] {
    const results: DecisionOutcome[] = [];

    for (const strat of this.strategies) {
      const outcome = this.evaluateStrategy(strat, pool, enrichment, safety, openPositionCounts);
      results.push(outcome);
    }

    detectToDecisionMs.observe(Date.now() - (pool.detectedAt ?? Date.now()));
    return results;
  }

  private evaluateStrategy(
    strat: StrategyConfig,
    pool: PoolEvent,
    enrichment: MintEnrichment | null,
    safety: SafetyVerdict,
    openPositionCounts: Map<string, number>,
  ): DecisionOutcome {
    const cfg: EntryConfig = {
      minSol: strat.minSol,
      allowedTypes: strat.allowedTypes as EntryConfig["allowedTypes"],
      requireMintSanity: strat.requireMintSanity,
      requireGraduation: strat.requireGraduation,
      maxDeployerPriorLaunches: strat.maxDeployerPriorLaunches,
      allowedQuoteMints: strat.allowedQuoteMints
        ? new Set(strat.allowedQuoteMints)
        : new Set([WSOL]),
    };

    const ctx = { pool, enrichment, blocklist: new Set<string>() };
    const entry = evaluateEntry(ctx, cfg);

    if (!entry.ok) {
      return { fire: false, strategyId: strat.id, plan: null, reasons: entry.reasons };
    }

    if (!safety.pass) {
      return {
        fire: false,
        strategyId: strat.id,
        plan: null,
        reasons: entry.reasons,
        blocked: "safety",
      };
    }

    // Check max simultaneous positions
    const openCount = openPositionCounts.get(strat.id) ?? 0;
    if (openCount >= strat.maxSimultaneousPositions) {
      return {
        fire: false,
        strategyId: strat.id,
        plan: null,
        reasons: entry.reasons,
        blocked: `max_positions (${openCount}/${strat.maxSimultaneousPositions})`,
      };
    }

    // Compute size
    const sizeSol = this.computeSize(strat, pool);

    // Find the non-stable mint
    const mint = pool.tokens.find((t) => !STABLE_MINTS.has(t));
    if (!mint) {
      return {
        fire: false,
        strategyId: strat.id,
        plan: null,
        reasons: [...entry.reasons, "no non-stable token found"],
      };
    }

    const exitConfig: TradePlan["exitConfig"] = {
      ladderRungs: strat.exit.ladderRungs,
      trailPct: strat.exit.trailPct,
      holdSec: strat.exit.holdSec,
      stopPct: strat.exit.stopPct,
      drainPct: strat.exit.drainPct,
      decayN: strat.exit.decayN,
    };

    const id = traceId();
    const plan: TradePlan = {
      attemptId: traceId(),
      traceId: id,
      strategyId: strat.id,
      mint,
      pool: pool.txSignature,
      dexKey: pool.dexKey,
      sizeSol,
      maxSlippageBps: strat.maxSlippageBps,
      computeUnitLimit: 200_000,
      priorityFeeMicroLamports: 0,
      exitConfig,
      kind: "entry",
      inputMint: WSOL,
      outputMint: mint,
      createdAt: Date.now(),
    };

    return {
      fire: true,
      strategyId: strat.id,
      plan,
      reasons: entry.fired,
    };
  }

  private computeSize(strat: StrategyConfig, pool: PoolEvent): number {
    const tiers = strat.sizeByLiquidity;
    if (!tiers || tiers.length === 0) return strat.sizeSol;

    // Sort descending by minSol so we pick the highest qualifying tier
    const sorted = [...tiers].sort((a, b) => b.minSol - a.minSol);
    for (const tier of sorted) {
      if (pool.solValue >= tier.minSol) return tier.size;
    }
    return strat.sizeSol;
  }
}
