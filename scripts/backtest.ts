#!/usr/bin/env bun
/**
 * backtest.ts
 *
 * Replays captured pools (data/pools.jsonl) against the strategy
 * profiles in scripts/lib/signals.ts, using the price series in
 * data/prices.jsonl. For each pool whose entry rule fires, opens a
 * simulated position one snapshot after the capture, then iterates the
 * remaining snapshots applying exit rules.
 *
 * Fill model (POC, intentionally simple):
 *   - Entry: first PriceSnap for the mint with takenAt > pool.capturedAt.
 *   - Exit:  PriceSnap when an exit rule fires; price = snap.priceQuotePerBase.
 *   - Slippage: priceImpact = sizeSol / (poolQuoteReserve + sizeSol). Apply
 *     to both entry (price *= 1 + impact) and partial/full exits
 *     (price *= 1 − impact).
 *   - Gas: flat 0.0005 SOL per side (entry + each partial).
 *
 * Usage:
 *   bun scripts/backtest.ts                                 # all strategies, full data
 *   bun scripts/backtest.ts --strategy S1-pumpfun-grad
 *   bun scripts/backtest.ts --since 2026-05-13
 *   bun scripts/backtest.ts --until 2026-05-15
 *   bun scripts/backtest.ts --out data/trades.jsonl
 *   bun scripts/backtest.ts --csv                           # dump per-trade rows
 *   bun scripts/backtest.ts --no-slippage                   # disable slippage model
 */

import { getFlag, getFloat, hasFlag } from "./lib/cli.ts";
import { ANSI, color, fmtPct, fmtSol, ts } from "./lib/format.ts";
import { appendJsonl, readJson, readJsonl, writeJson } from "./lib/storage.ts";
import { STRATEGIES, STRATEGY_BY_ID, evaluateEntry, evaluateExit } from "./lib/signals.ts";
import { STABLE_MINTS } from "./lib/dexes.ts";
import type {
  ExitReason,
  MintEnrichment,
  PoolEvent,
  Position,
  PriceSnap,
  SimTrade,
} from "./lib/types.ts";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const GAS_PER_SIDE = 0.0005;

interface BacktestConfig {
  strategyFilter: string | null;
  enrichDir: string;
  blocklistPath: string;
  poolsPath: string;
  pricesPath: string;
  tradesOut: string;
  since: number | null;
  until: number | null;
  applySlippage: boolean;
  csv: boolean;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function loadEnrichmentMap(dir: string, mints: Set<string>): Map<string, MintEnrichment> {
  const out = new Map<string, MintEnrichment>();
  for (const mint of mints) {
    const path = join(dir, `${mint}.json`);
    if (!existsSync(path)) continue;
    const e = readJson<MintEnrichment | null>(path, null);
    if (e) out.set(mint, e);
  }
  return out;
}

function pickMint(pool: PoolEvent): string | null {
  return pool.tokens.find((t) => !STABLE_MINTS.has(t)) ?? null;
}

interface Outcome extends SimTrade {
  partials: Array<{ at: string; price: number; fraction: number; reason: ExitReason }>;
}

/**
 * Run the exit loop on a position against the price series for its mint.
 * Returns one final SimTrade describing entry + the weighted close.
 */
function runPosition(
  pos: Position,
  entrySnap: PriceSnap,
  series: PriceSnap[],
  exitCfg: ReturnType<typeof getExit>,
  applySlippage: boolean,
): Outcome {
  const partials: Outcome["partials"] = [];
  let exitReason: ExitReason = "end-of-data";
  let exitSnap: PriceSnap = entrySnap;
  let exitPrice = pos.entryPrice;
  const prevSnaps: PriceSnap[] = [entrySnap];

  for (const snap of series) {
    // Update peak before evaluating exits — both X1 ladder and X2 trail
    // rely on it.
    if (snap.priceQuotePerBase > pos.peakPrice) pos.peakPrice = snap.priceQuotePerBase;

    const decision = evaluateExit(pos, snap, prevSnaps, exitCfg);
    if (decision.exit) {
      const slippage =
        applySlippage && snap.quoteReserve > 0
          ? Math.min(0.2, (pos.size * decision.sellFraction) / (snap.quoteReserve + 1e-9))
          : 0;
      const fillPrice = decision.price * (1 - slippage);
      const tokensSold = pos.tokenAmount * decision.sellFraction;
      const proceeds = tokensSold * fillPrice;
      pos.realisedSol += proceeds - GAS_PER_SIDE;
      pos.realisedFrac += decision.sellFraction;
      pos.tokenAmount -= tokensSold;
      partials.push({
        at: snap.takenAt,
        price: fillPrice,
        fraction: decision.sellFraction,
        reason: decision.reason,
      });
      exitReason = decision.reason;
      exitSnap = snap;
      exitPrice = fillPrice;
      if (pos.realisedFrac >= 1 - 1e-9) break;
    }
    prevSnaps.push(snap);
    if (prevSnaps.length > 32) prevSnaps.shift();
  }

  // Any residual position → mark to last snapshot price as "end-of-data".
  if (pos.realisedFrac < 1 - 1e-9) {
    const last = series[series.length - 1] ?? entrySnap;
    const slippage =
      applySlippage && last.quoteReserve > 0
        ? Math.min(0.2, ((pos.size * (1 - pos.realisedFrac))) / (last.quoteReserve + 1e-9))
        : 0;
    const fillPrice = last.priceQuotePerBase * (1 - slippage);
    pos.realisedSol += pos.tokenAmount * fillPrice;
    if (exitReason === "end-of-data") {
      exitSnap = last;
      exitPrice = fillPrice;
    }
  }

  const pnlSol = pos.realisedSol - pos.size;
  const pnlPct = pos.size > 0 ? pnlSol / pos.size : 0;
  const durationSec =
    (new Date(exitSnap.takenAt).getTime() - new Date(pos.entryAt).getTime()) / 1000;

  return {
    strategyId: pos.strategyId,
    poolSignature: pos.poolSignature,
    mint: pos.mint,
    dexKey: pos.dexKey,
    entrySlot: pos.entrySlot,
    entryAt: pos.entryAt,
    entryPrice: pos.entryPrice,
    entrySolSize: pos.size,
    exitSlot: exitSnap.slot,
    exitAt: exitSnap.takenAt,
    exitPrice,
    exitReason,
    pnlSol,
    pnlPct,
    peakPrice: pos.peakPrice,
    durationSec,
    partials,
  };
}

function getExit(stratId: string) {
  return STRATEGY_BY_ID[stratId]!.exit;
}

interface StratReport {
  trades: Outcome[];
}

function summarise(report: StratReport, useColor: boolean): void {
  const { trades } = report;
  if (trades.length === 0) {
    console.log(color(useColor, ANSI.dim, "   (no trades)"));
    return;
  }
  const returns = trades.map((t) => t.pnlPct);
  const sortedRet = [...returns].sort((a, b) => a - b);
  const sum = returns.reduce((s, x) => s + x, 0);
  const mean = sum / returns.length;
  const median = sortedRet[Math.floor(sortedRet.length / 2)] ?? 0;
  const wins = returns.filter((r) => r > 0).length;
  const hitRate = wins / returns.length;
  const std = Math.sqrt(
    returns.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, returns.length - 1),
  );
  const minR = sortedRet[0] ?? 0;
  const maxR = sortedRet[sortedRet.length - 1] ?? 0;
  let peak = 0;
  let drawdown = 0;
  let cum = 0;
  for (const r of returns) {
    cum += r;
    peak = Math.max(peak, cum);
    drawdown = Math.min(drawdown, cum - peak);
  }
  const reasonHist = new Map<ExitReason, number>();
  for (const t of trades) reasonHist.set(t.exitReason, (reasonHist.get(t.exitReason) ?? 0) + 1);
  const meanDuration = trades.reduce((s, t) => s + t.durationSec, 0) / trades.length;

  console.log(
    `   n=${trades.length}  hit=${(hitRate * 100).toFixed(1)}%  ` +
      `mean=${fmtPct(mean)}  med=${fmtPct(median)}  std=${fmtPct(std)}  ` +
      `worst=${fmtPct(minR)}  best=${fmtPct(maxR)}  dd=${fmtPct(drawdown)}`,
  );
  console.log(
    `   avg-hold=${(meanDuration / 60).toFixed(1)}min  ` +
      `pnlSum=${fmtSol(trades.reduce((s, t) => s + t.pnlSol, 0))} SOL  ` +
      `exits=${[...reasonHist.entries()].map(([r, n]) => `${r}:${n}`).join(" ")}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg: BacktestConfig = {
    strategyFilter: getFlag(argv, "--strategy") ?? null,
    enrichDir: getFlag(argv, "--enrich") || "data/enrich",
    blocklistPath: getFlag(argv, "--blocklist") || "data/blocklist.json",
    poolsPath: getFlag(argv, "--pools") || "data/pools.jsonl",
    pricesPath: getFlag(argv, "--prices") || "data/prices.jsonl",
    tradesOut: getFlag(argv, "--out") || "data/trades.jsonl",
    since: parseDate(getFlag(argv, "--since")),
    until: parseDate(getFlag(argv, "--until")),
    applySlippage: !hasFlag(argv, "--no-slippage"),
    csv: hasFlag(argv, "--csv"),
  };
  const useColor = !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY);
  // Optional: positionFloorSol so we can stress-test S4 with smaller min sizes.
  const positionFloor = getFloat(argv, "--position-floor", 0);

  if (cfg.strategyFilter && !STRATEGY_BY_ID[cfg.strategyFilter]) {
    console.error(`Unknown strategy ${cfg.strategyFilter}. Known: ${STRATEGIES.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const pools = readJsonl<PoolEvent>(cfg.poolsPath);
  const prices = readJsonl<PriceSnap>(cfg.pricesPath);
  if (pools.length === 0) {
    console.error(`[${ts()}] no pools in ${cfg.poolsPath}`);
    process.exit(1);
  }
  if (prices.length === 0) {
    console.error(`[${ts()}] no prices in ${cfg.pricesPath}`);
    process.exit(1);
  }

  // Index prices by mint, time-sorted.
  const pricesByMint = new Map<string, PriceSnap[]>();
  for (const p of prices) {
    const arr = pricesByMint.get(p.mint) ?? [];
    arr.push(p);
    pricesByMint.set(p.mint, arr);
  }
  for (const arr of pricesByMint.values()) {
    arr.sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  }

  // Filter pools by window + presence of price series.
  const candidatePools = pools.filter((p) => {
    const t = Date.parse(p.capturedAt);
    if (cfg.since !== null && t < cfg.since) return false;
    if (cfg.until !== null && t > cfg.until) return false;
    const mint = pickMint(p);
    return mint !== null && (pricesByMint.get(mint)?.length ?? 0) >= 2;
  });

  const enrichmentMap = loadEnrichmentMap(
    cfg.enrichDir,
    new Set(candidatePools.map((p) => pickMint(p)!).filter(Boolean)),
  );
  const blocklist = new Set(readJson<string[]>(cfg.blocklistPath, []));

  console.log(
    color(
      useColor,
      ANSI.dim,
      `[${ts()}] backtest: ${candidatePools.length} candidate pools, ${prices.length} snaps, slippage=${cfg.applySlippage}, out=${cfg.tradesOut}`,
    ),
  );

  // Clear previous trades file. JSONL is append-only and we want fresh
  // runs to replace stale rows.
  if (existsSync(cfg.tradesOut)) unlinkSync(cfg.tradesOut);

  const strategies = cfg.strategyFilter
    ? [STRATEGY_BY_ID[cfg.strategyFilter]!]
    : STRATEGIES;

  for (const strat of strategies) {
    const report: StratReport = { trades: [] };
    for (const pool of candidatePools) {
      const mint = pickMint(pool);
      if (!mint) continue;
      const enrichment = enrichmentMap.get(mint) ?? null;
      const entry = evaluateEntry({ pool, enrichment, blocklist }, strat.entry);
      if (!entry.ok) continue;

      const series = pricesByMint.get(mint) ?? [];
      const poolTime = Date.parse(pool.capturedAt);
      const entryIdx = series.findIndex((s) => Date.parse(s.takenAt) > poolTime);
      if (entryIdx < 0 || entryIdx >= series.length - 1) continue;
      const entrySnap = series[entryIdx]!;
      const rest = series.slice(entryIdx + 1);
      // Sanity floor: skip ghost pools where vault discovery returned an
      // empty side. Real pools have non-trivial quote reserves; entries
      // into "pools" with < 10 SOL of quote are noise that produces
      // ladder-runner artefacts as the price ratio explodes.
      if (entrySnap.priceQuotePerBase <= 0) continue;
      if (entrySnap.quoteReserve < 10) continue;
      if (entrySnap.baseReserve <= 0) continue;
      let size = strat.sizeSol(pool);
      if (positionFloor > 0) size = Math.max(size, positionFloor);

      // Slippage on entry: priceImpact applied to entryPrice.
      const slippage =
        cfg.applySlippage && entrySnap.quoteReserve > 0
          ? Math.min(0.2, size / (entrySnap.quoteReserve + 1e-9))
          : 0;
      const effectiveEntry = entrySnap.priceQuotePerBase * (1 + slippage);
      // Tokens received after gas.
      const tokens = (size - GAS_PER_SIDE) / effectiveEntry;
      if (!Number.isFinite(tokens) || tokens <= 0) continue;

      const pos: Position = {
        strategyId: strat.id,
        poolSignature: pool.txSignature,
        mint,
        dexKey: pool.dexKey,
        entrySlot: entrySnap.slot,
        entryAt: entrySnap.takenAt,
        entryPrice: effectiveEntry,
        baselineQuoteReserve: entrySnap.quoteReserve,
        size,
        tokenAmount: tokens,
        peakPrice: effectiveEntry,
        realisedFrac: 0,
        realisedSol: 0,
      };
      const outcome = runPosition(pos, entrySnap, rest, strat.exit, cfg.applySlippage);
      report.trades.push(outcome);
      appendJsonl<SimTrade>(cfg.tradesOut, outcome);
    }

    console.log("");
    console.log(color(useColor, ANSI.bold, `=== ${strat.id} ===`));
    summarise(report, useColor);
    if (cfg.csv && report.trades.length > 0) {
      console.log(color(useColor, ANSI.dim, "   --- per-trade ---"));
      for (const t of report.trades) {
        console.log(
          `   ${t.mint.slice(0, 6)}…  ${t.dexKey.padEnd(15)} ` +
            `entry=${t.entryPrice.toExponential(2)} exit=${t.exitPrice.toExponential(2)} ` +
            `pnl=${fmtPct(t.pnlPct)} reason=${t.exitReason}`,
        );
      }
    }
  }

  // Write a small summary doc next to trades for the demo.
  const summary = {
    generatedAt: new Date().toISOString(),
    config: cfg,
    strategies: strategies.map((s) => s.id),
  };
  writeJson("data/backtest-last.json", summary);
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
