/**
 * Entry & exit signal evaluators + strategy composition.
 *
 * Pure functions, no IO. The backtest harness composes them; the
 * scripts/signals.ts CLI calls them for inspection.
 *
 * Reference: docs/research.md sections 2-4.
 */

import { STABLE_MINTS, WSOL } from "./dexes.ts";
import type { ExitReason, MintEnrichment, PoolEvent, Position, PriceSnap } from "./types.ts";
import type { StrategyConfig } from "./config.ts";

export interface SignalDecision {
  ok: boolean;
  reason: string;
}

export interface EntryContext {
  pool: PoolEvent;
  enrichment: MintEnrichment | null;
  blocklist: Set<string>;
}

export interface EntryConfig {
  /** Minimum SOL value at pool open. */
  minSol: number;
  /** Required event types; empty = any. */
  allowedTypes?: PoolEvent["eventType"][];
  /** Required DEX keys; empty/undefined = any. */
  allowedDexes?: string[];
  /** Require mintAuthority and freezeAuthority to be null. */
  requireMintSanity: boolean;
  /** Require pump.fun MIGRATE source. */
  requireGraduation: boolean;
  /** Skip if E6 deployer history shows ≥ this many priors (proxy for serial rugger). */
  maxDeployerPriorLaunches?: number;
  /** Required allowed quote tokens (mints). */
  allowedQuoteMints: Set<string>;
  /** E8 — max top-10 holder concentration (fraction 0..1). Undefined = skip. */
  maxTop10Concentration?: number;
}

// ============================== Entry =====================================

/** E1 — first liquidity (INIT or MIGRATE; first DEPOSIT acceptable). */
export function e1FirstLiquidity(ctx: EntryContext): SignalDecision {
  const t = ctx.pool.eventType;
  if (t === "INIT" || t === "MIGRATE" || t === "CREATE" || t === "DEPOSIT") {
    return { ok: true, reason: `E1 ${t}` };
  }
  return { ok: false, reason: `E1 unknown type ${String(t)}` };
}

/** E2 — size gate. */
export function e2SizeGate(ctx: EntryContext, minSol: number): SignalDecision {
  if (ctx.pool.solValue >= minSol) {
    return { ok: true, reason: `E2 ${ctx.pool.solValue.toFixed(2)}≥${minSol}` };
  }
  return { ok: false, reason: `E2 ${ctx.pool.solValue.toFixed(2)}<${minSol}` };
}

/** E3 — mint authority and freeze authority renounced. */
export function e3MintSanity(ctx: EntryContext): SignalDecision {
  if (!ctx.enrichment) return { ok: false, reason: "E3 no-enrichment" };
  const m = ctx.enrichment.mintAuthority;
  const f = ctx.enrichment.freezeAuthority;
  if (m === null && f === null) return { ok: true, reason: "E3 authorities-null" };
  return {
    ok: false,
    reason: `E3 mintAuthority=${m ? "set" : "null"} freezeAuthority=${f ? "set" : "null"}`,
  };
}

/** E4 — LP burned/locked heuristic. */
export function e4LpLocked(ctx: EntryContext): SignalDecision {
  if (!ctx.enrichment) return { ok: false, reason: "E4 no-enrichment" };
  if (ctx.enrichment.lpBurnedOrLocked === true) return { ok: true, reason: "E4 lp-burned" };
  return { ok: false, reason: "E4 lp-not-burned" };
}

/** E5 — pump.fun graduation (MIGRATE on pumpfun). */
export function e5Graduation(ctx: EntryContext): SignalDecision {
  const p = ctx.pool;
  if (p.dexKey === "pumpfun" && p.eventType === "MIGRATE") {
    return { ok: true, reason: "E5 pumpfun-migrate" };
  }
  // Post-migration LP add on PumpSwap or Raydium also counts within a
  // short window — but without the migration link we can't be sure. POC:
  // only accept the direct MIGRATE event.
  return { ok: false, reason: "E5 not-graduation" };
}

/** E6 — deployer reputation: not on blocklist, prior-launch count below cap. */
export function e6DeployerRep(
  ctx: EntryContext,
  maxPriorLaunches: number | undefined,
): SignalDecision {
  if (!ctx.pool.signer) return { ok: false, reason: "E6 no-signer" };
  if (ctx.blocklist.has(ctx.pool.signer)) return { ok: false, reason: "E6 blocklisted" };
  if (maxPriorLaunches === undefined) return { ok: true, reason: "E6 no-cap" };
  const prior = ctx.enrichment?.deployerPriorLaunches;
  if (prior === null || prior === undefined) return { ok: true, reason: "E6 no-history" };
  if (prior <= maxPriorLaunches) return { ok: true, reason: `E6 prior=${prior}` };
  return { ok: false, reason: `E6 prior=${prior}>${maxPriorLaunches}` };
}

/** E7 — quote-token whitelist. Inferred from non-stable mint absence: the
 *  *other* mint in the pool is the quote, which capture stripped from
 *  `tokens`. We approximate by checking that *some* non-stable token
 *  exists (else the pool is stable-stable which we don't want). */
export function e7QuoteWhitelist(ctx: EntryContext, allowed: Set<string>): SignalDecision {
  // A pool with both legs in stables would have tokens=[]; reject.
  const baseMint = ctx.pool.tokens.find((t) => !STABLE_MINTS.has(t));
  if (!baseMint) return { ok: false, reason: "E7 no-base-token" };
  // We have a non-stable side; assume the other leg is a stable. Since
  // capture filters stables out of tokens, we can't directly read which
  // stable it is — accept if any allowed mint is a stable. For POC,
  // STABLE_MINTS ⊆ allowed is the common case.
  for (const s of STABLE_MINTS) {
    if (allowed.has(s)) return { ok: true, reason: "E7 stable-quote-likely" };
  }
  return { ok: false, reason: "E7 no-allowed-quote" };
}

/** E8 — top-holder concentration: reject if top-10 holders control too much supply.
 *  High concentration (> threshold) means a small number of wallets can dump
 *  and crater the price. Soft-pass when enrichment is unavailable. */
export function e8Concentration(ctx: EntryContext, maxConcentration: number): SignalDecision {
  if (!ctx.enrichment) return { ok: true, reason: "E8 no-enrichment" };
  const c = ctx.enrichment.top10Concentration;
  if (c <= maxConcentration) return { ok: true, reason: `E8 conc=${(c * 100).toFixed(0)}%` };
  return {
    ok: false,
    reason: `E8 conc=${(c * 100).toFixed(0)}%>${(maxConcentration * 100).toFixed(0)}%`,
  };
}

export function evaluateEntry(
  ctx: EntryContext,
  cfg: EntryConfig,
): { ok: boolean; reasons: string[]; fired: string[] } {
  const reasons: string[] = [];
  const fired: string[] = [];

  const checks: SignalDecision[] = [
    e1FirstLiquidity(ctx),
    e2SizeGate(ctx, cfg.minSol),
    e7QuoteWhitelist(ctx, cfg.allowedQuoteMints),
  ];
  if (cfg.allowedTypes && cfg.allowedTypes.length > 0) {
    const t = ctx.pool.eventType;
    checks.push(
      cfg.allowedTypes.includes(t)
        ? { ok: true, reason: `type=${t}` }
        : { ok: false, reason: `type=${t} not in ${cfg.allowedTypes.join("|")}` },
    );
  }
  if (cfg.allowedDexes && cfg.allowedDexes.length > 0) {
    const d = ctx.pool.dexKey;
    checks.push(
      cfg.allowedDexes.includes(d)
        ? { ok: true, reason: `dex=${d}` }
        : { ok: false, reason: `dex=${d} not in ${cfg.allowedDexes.join("|")}` },
    );
  }
  if (cfg.requireMintSanity) checks.push(e3MintSanity(ctx));
  if (cfg.requireGraduation) checks.push(e5Graduation(ctx));
  if (cfg.maxDeployerPriorLaunches !== undefined) {
    checks.push(e6DeployerRep(ctx, cfg.maxDeployerPriorLaunches));
  }
  if (cfg.maxTop10Concentration !== undefined) {
    checks.push(e8Concentration(ctx, cfg.maxTop10Concentration));
  }

  let ok = true;
  for (const c of checks) {
    reasons.push(c.reason);
    if (c.ok) fired.push(c.reason);
    if (!c.ok) ok = false;
  }
  return { ok, reasons, fired };
}

// ============================== Exit ======================================

export interface ExitConfig {
  /** X1 — ladder rungs as [profitPct, sellFraction] pairs. */
  ladderRungs?: Array<{ profit: number; sell: number }>;
  /** X2 — trailing-stop fraction off the peak. */
  trailPct?: number;
  /** X3 — max time-in-trade. */
  holdSec?: number;
  /** X4 — hard stop loss fraction (negative number, e.g. -0.30). */
  stopPct?: number;
  /** X5 — liquidity drain: exit if quote reserves fall below this fraction of baseline. */
  drainPct?: number;
  /** X7 — momentum decay: N consecutive non-positive samples to exit. */
  decayN?: number;
}

export interface ExitDecision {
  exit: true;
  reason: ExitReason;
  /** Fraction of position sold (1.0 = full close). */
  sellFraction: number;
  /** Price at which the simulated exit is executed (= snap.priceQuotePerBase). */
  price: number;
}

export interface NoExit {
  exit: false;
}

export function evaluateExit(
  pos: Position,
  snap: PriceSnap,
  prevSnaps: PriceSnap[],
  cfg: ExitConfig,
): ExitDecision | NoExit {
  const elapsed = (new Date(snap.takenAt).getTime() - new Date(pos.entryAt).getTime()) / 1000;
  const px = snap.priceQuotePerBase;
  const ret = (px - pos.entryPrice) / pos.entryPrice;

  // X4 — hard stop, highest priority.
  if (cfg.stopPct !== undefined && ret <= cfg.stopPct) {
    return { exit: true, reason: "stop", sellFraction: 1, price: px };
  }

  // X5 — liquidity drain, second-highest priority (rug-pull protection).
  // Runs before ladder/trail so a draining pool doesn't get a false
  // "trail" exit at an already-deteriorated price.
  if (
    cfg.drainPct !== undefined &&
    pos.baselineQuoteReserve > 0 &&
    snap.quoteReserve < pos.baselineQuoteReserve * cfg.drainPct
  ) {
    return { exit: true, reason: "drain", sellFraction: 1, price: px };
  }

  // X1 — ladder.
  if (cfg.ladderRungs) {
    for (const rung of cfg.ladderRungs) {
      const targetReached = ret >= rung.profit;
      const cumulativeNeeded = sumLadderUpTo(cfg.ladderRungs, rung);
      if (targetReached && pos.realisedFrac < cumulativeNeeded - 1e-9) {
        const sell = Math.min(rung.sell, 1 - pos.realisedFrac);
        if (sell > 0) {
          // If the rung sells everything left, mark as runner exit.
          const isFinalRung = rung === cfg.ladderRungs[cfg.ladderRungs.length - 1];
          return {
            exit: true,
            reason: isFinalRung ? "ladder-runner" : "ladder-partial",
            sellFraction: sell,
            price: px,
          };
        }
      }
    }
  }

  // X2 — trailing stop, evaluated against peak.
  if (cfg.trailPct !== undefined && pos.peakPrice > 0) {
    const drop = (pos.peakPrice - px) / pos.peakPrice;
    if (drop >= cfg.trailPct && ret > 0) {
      return { exit: true, reason: "trail", sellFraction: 1, price: px };
    }
  }
  // X7 — momentum decay.
  if (cfg.decayN && prevSnaps.length >= cfg.decayN) {
    const tail = prevSnaps.slice(-cfg.decayN).concat(snap);
    let negative = 0;
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1];
      const b = tail[i];
      if (!a || !b) continue;
      if (b.priceQuotePerBase <= a.priceQuotePerBase) negative++;
    }
    if (negative >= cfg.decayN) {
      return { exit: true, reason: "decay", sellFraction: 1, price: px };
    }
  }

  // X3 — time stop, lowest priority.
  if (cfg.holdSec !== undefined && elapsed >= cfg.holdSec) {
    return { exit: true, reason: "time", sellFraction: 1, price: px };
  }

  return { exit: false };
}

function sumLadderUpTo(
  rungs: Array<{ profit: number; sell: number }>,
  target: { profit: number; sell: number },
): number {
  let s = 0;
  for (const r of rungs) {
    s += r.sell;
    if (r === target) return s;
  }
  return s;
}

// ============================== Strategies ================================

export interface Strategy {
  id: string;
  /** Per-strategy entry config. */
  entry: EntryConfig;
  /** Per-strategy exit config. */
  exit: ExitConfig;
  /** Position size in SOL. Function lets S4 size on event SOL. */
  sizeSol: (pool: PoolEvent) => number;
  maxSlippageBps?: number;
  maxFeeLamports?: number;
  maxSimultaneousPositions?: number;
  enabled?: boolean;
}

const QUOTE_WHITELIST = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

/** Standard exit profile used by S1-S3 with per-strategy overrides. */
const BASE_EXIT: ExitConfig = {
  ladderRungs: [
    { profit: 0.5, sell: 0.5 },
    { profit: 1.0, sell: 0.25 },
    { profit: 2.0, sell: 0.25 },
  ],
  trailPct: 0.25,
  holdSec: 30 * 60,
  stopPct: -0.3,
  drainPct: 0.5,
  decayN: 5,
};

export const STRATEGIES: Strategy[] = [
  {
    id: "S1-pumpfun-grad",
    entry: {
      minSol: 5,
      requireMintSanity: false, // pump.fun graduates have null authorities by construction
      requireGraduation: true,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: { ...BASE_EXIT, trailPct: 0.2, holdSec: 15 * 60 },
    sizeSol: () => 0.5,
  },
  {
    id: "S2-meteora-dlmm-size",
    entry: {
      minSol: 25,
      allowedTypes: ["INIT", "DEPOSIT"],
      allowedDexes: ["meteora-dlmm", "meteora-damm-v2"],
      requireMintSanity: true,
      requireGraduation: false,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: { ...BASE_EXIT, holdSec: 60 * 60, stopPct: -0.35 },
    sizeSol: () => 1.0,
  },
  {
    id: "S3-raydium-fresh-pool",
    entry: {
      minSol: 5,
      allowedTypes: ["INIT"],
      allowedDexes: ["raydium-clmm"],
      requireMintSanity: true,
      requireGraduation: false,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: { ...BASE_EXIT },
    sizeSol: () => 0.5,
  },
  {
    // S4: broad catch-all, but exclude the net-negative DEXes.
    // Data: raydium-amm DEPOSIT is -8.8% avg end return, raydium-cpmm INIT
    // is -44.8%. Both drag the portfolio.
    id: "S4-tiered-multidex",
    entry: {
      minSol: 1,
      allowedDexes: [
        "meteora-damm-v2",
        "meteora-dlmm",
        "raydium-clmm",
        "orca-whirlpool",
        "pumpfun",
        "pumpswap",
      ],
      requireMintSanity: true,
      requireGraduation: false,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: { ...BASE_EXIT, trailPct: 0.15, holdSec: 30 * 60, decayN: 12 },
    sizeSol: (pool) => {
      if (pool.solValue < 5) return 0.1;
      if (pool.solValue < 25) return 0.5;
      return 1.0;
    },
  },
  {
    // S5: ride the pump, wider trail to let winners run.
    // Extended data (80+ min series) proves 5% trail exits too early: costs
    // +55% on 98sMhv by exiting at +5% when it reaches +42%.
    // 10% trail + 30min hold + 15%/20% ladder: net positive on 20-trade
    // dataset even excluding the +239% outlier.
    id: "S5-fast-trail",
    entry: {
      minSol: 0.5,
      allowedDexes: [
        "meteora-damm-v2",
        "meteora-dlmm",
        "raydium-clmm",
        "orca-whirlpool",
        "pumpfun",
        "pumpswap",
      ],
      requireMintSanity: true,
      requireGraduation: false,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: {
      ladderRungs: [
        { profit: 0.05, sell: 0.2 },
        { profit: 0.15, sell: 0.2 },
      ],
      trailPct: 0.1,
      holdSec: 30 * 60,
      stopPct: -0.2,
      drainPct: 0.3,
      decayN: 999,
    },
    sizeSol: (pool) => {
      if (pool.solValue < 5) return 0.1;
      if (pool.solValue < 25) return 0.5;
      return 1.0;
    },
  },
  {
    // S6: INIT/CREATE sniper — targets new pool creation events.
    // Data: meteora-damm-v2 INIT was +39.5% avg peak at 67% win rate.
    // Excludes raydium-cpmm (the only INIT with negative returns: -44.8%).
    // Protective ladder at +15% (sell 25%), then scale out at +50% and +100%.
    // First rung at 15% (not 20%) to survive slippage on thin INIT pools.
    id: "S6-init-sniper",
    entry: {
      minSol: 3,
      requireMintSanity: true,
      requireGraduation: false,
      allowedTypes: ["INIT", "CREATE"],
      allowedDexes: [
        "meteora-damm-v2",
        "meteora-dlmm",
        "raydium-clmm",
        "orca-whirlpool",
        "pumpfun",
        "pumpswap",
      ],
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: {
      ladderRungs: [
        { profit: 0.05, sell: 0.15 },
        { profit: 0.15, sell: 0.25 },
        { profit: 0.5, sell: 0.25 },
        { profit: 1.0, sell: 0.25 },
      ],
      trailPct: 0.08,
      holdSec: 60 * 60,
      stopPct: -0.25,
      drainPct: 0.3,
      decayN: 999,
    },
    sizeSol: (pool) => {
      if (pool.solValue < 5) return 0.1;
      if (pool.solValue < 25) return 0.5;
      return 1.0;
    },
    maxSimultaneousPositions: 5,
  },
  {
    // S7: Meteora DAMM v2 alpha — the single strongest signal in our dataset.
    // Data: 7 INIT events, 71% win rate, avg peak +81% (excl. outlier +826k%).
    // Aggressive sizing on highest-conviction signal.
    // Protective ladder: sell 30% at +10%. Set lower than S5/S6 because
    // aggressive sizing causes more entry slippage (9%+ on thin pools),
    // reducing effective returns. 10% threshold ensures the protective
    // rung fires even with maximum slippage.
    id: "S7-meteora-alpha",
    entry: {
      minSol: 3,
      allowedTypes: ["INIT"],
      allowedDexes: ["meteora-damm-v2"],
      requireMintSanity: true,
      requireGraduation: false,
      allowedQuoteMints: QUOTE_WHITELIST,
    },
    exit: {
      ladderRungs: [
        { profit: 0.05, sell: 0.2 },
        { profit: 0.1, sell: 0.3 },
      ],
      trailPct: 0.08,
      holdSec: 30 * 60,
      stopPct: -0.25,
      drainPct: 0.3,
      decayN: 999,
    },
    sizeSol: (pool) => {
      if (pool.solValue < 5) return 0.2;
      if (pool.solValue < 25) return 1.0;
      return 2.0;
    },
    maxSimultaneousPositions: 3,
  },
];

export const STRATEGY_BY_ID: Record<string, Strategy> = Object.fromEntries(
  STRATEGIES.map((s) => [s.id, s]),
);

/** Build Strategy objects from YAML-loaded StrategyConfig entries. */
export function strategiesFromConfig(configs: StrategyConfig[]): Strategy[] {
  return configs.map((cfg): Strategy => {
    const quoteMints = cfg.allowedQuoteMints ? new Set(cfg.allowedQuoteMints) : new Set([WSOL]);

    const entry: EntryConfig = {
      minSol: cfg.minSol,
      allowedTypes: cfg.allowedTypes as EntryConfig["allowedTypes"],
      allowedDexes: cfg.allowedDexes,
      requireMintSanity: cfg.requireMintSanity,
      requireGraduation: cfg.requireGraduation,
      maxDeployerPriorLaunches: cfg.maxDeployerPriorLaunches,
      allowedQuoteMints: quoteMints,
    };

    const exit: ExitConfig = {
      ladderRungs: cfg.exit.ladderRungs,
      trailPct: cfg.exit.trailPct,
      holdSec: cfg.exit.holdSec,
      stopPct: cfg.exit.stopPct,
      drainPct: cfg.exit.drainPct,
      decayN: cfg.exit.decayN,
    };

    const tiers = cfg.sizeByLiquidity;
    let sizeSol: (pool: PoolEvent) => number;
    if (tiers && tiers.length > 0) {
      const sorted = [...tiers].sort((a, b) => b.minSol - a.minSol);
      sizeSol = (pool: PoolEvent) => {
        for (const tier of sorted) {
          if (pool.solValue >= tier.minSol) return tier.size;
        }
        return cfg.sizeSol;
      };
    } else {
      const flat = cfg.sizeSol;
      sizeSol = (_pool: PoolEvent) => flat;
    }

    return {
      id: cfg.id,
      entry,
      exit,
      sizeSol,
      maxSlippageBps: cfg.maxSlippageBps,
      maxFeeLamports: cfg.maxFeeLamports,
      maxSimultaneousPositions: cfg.maxSimultaneousPositions,
      enabled: cfg.enabled,
    };
  });
}
