#!/usr/bin/env bun
/**
 * pick-best.ts
 *
 * Reads data/trades.jsonl (output of scripts/backtest.ts), scores every
 * strategy that produced trades, and prints the winner + a compact
 * proof-style markdown block fit for pasting into docs/proof.md.
 *
 * Scoring: weighted combination of
 *   - total PnL (40%)
 *   - hit rate (30%)
 *   - mean return (20%)
 *   - −1 × max drawdown (10%)
 * Tied scores break on sample count (more trades = more confidence).
 *
 * Usage:
 *   bun scripts/pick-best.ts                       # print summary to stdout
 *   bun scripts/pick-best.ts --md                  # markdown formatted only
 *   bun scripts/pick-best.ts --in data/trades.jsonl
 */

import { getFlag, hasFlag } from "./lib/cli.ts";
import { readJsonl } from "./lib/storage.ts";
import type { SimTrade } from "./lib/types.ts";

interface StratStats {
  id: string;
  n: number;
  hit: number;
  mean: number;
  median: number;
  std: number;
  best: number;
  worst: number;
  drawdown: number;
  pnlSum: number;
  avgHoldSec: number;
  exits: Record<string, number>;
  score: number;
}

function score(stats: Omit<StratStats, "id" | "score">): number {
  const pnlComponent = Math.tanh(stats.pnlSum / 2);
  const meanComponent = Math.tanh(stats.mean * 2);
  const ddComponent = stats.drawdown;
  return 0.4 * pnlComponent + 0.3 * stats.hit + 0.2 * meanComponent + 0.1 * ddComponent;
}

function statsFor(strategyId: string, trades: SimTrade[]): StratStats {
  const returns = trades.map((t) => t.pnlPct);
  const sortedRet = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const median = sortedRet[Math.floor(sortedRet.length / 2)] ?? 0;
  const std = Math.sqrt(
    returns.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, returns.length - 1),
  );
  let peak = 0;
  let drawdown = 0;
  let cum = 0;
  for (const r of returns) {
    cum += r;
    peak = Math.max(peak, cum);
    drawdown = Math.min(drawdown, cum - peak);
  }
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  const partial: Omit<StratStats, "id" | "score"> = {
    n: trades.length,
    hit: trades.filter((t) => t.pnlSol > 0).length / trades.length,
    mean,
    median,
    std,
    best: sortedRet[sortedRet.length - 1] ?? 0,
    worst: sortedRet[0] ?? 0,
    drawdown,
    pnlSum: trades.reduce((s, t) => s + t.pnlSol, 0),
    avgHoldSec: trades.reduce((s, t) => s + t.durationSec, 0) / trades.length,
    exits,
  };
  return { id: strategyId, ...partial, score: score(partial) };
}

function asPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function asSol(x: number): string {
  return `${x.toFixed(3)} SOL`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const inPath = getFlag(argv, "--in") || "data/trades.jsonl";
  const mdOnly = hasFlag(argv, "--md");

  const trades = readJsonl<SimTrade>(inPath);
  if (trades.length === 0) {
    console.error(`No trades in ${inPath}. Run scripts/backtest.ts first.`);
    process.exit(1);
  }
  const byStrategy = new Map<string, SimTrade[]>();
  for (const t of trades) {
    const arr = byStrategy.get(t.strategyId) ?? [];
    arr.push(t);
    byStrategy.set(t.strategyId, arr);
  }
  const stats = [...byStrategy.entries()].map(([id, ts]) => statsFor(id, ts));
  stats.sort((a, b) => b.score - a.score || b.n - a.n);

  const winner = stats[0]!;
  if (!mdOnly) {
    console.log("=== strategy bake-off ===\n");
    for (const s of stats) {
      const exits = Object.entries(s.exits)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      console.log(
        `${s.id.padEnd(28)} score=${s.score.toFixed(3)}  n=${s.n}  hit=${asPct(s.hit)}  ` +
          `mean=${asPct(s.mean)}  pnl=${asSol(s.pnlSum)}  worst=${asPct(s.worst)}  ` +
          `dd=${asPct(s.drawdown)}  hold=${(s.avgHoldSec / 60).toFixed(1)}min  ${exits}`,
      );
    }
    console.log("");
  }

  // Markdown block
  console.log(`## Winning strategy: \`${winner.id}\`\n`);
  console.log(
    `**Composite score:** ${winner.score.toFixed(3)} ` +
      `(0.4 × tanh(pnl/2) + 0.3 × hit + 0.2 × tanh(2 × mean) + 0.1 × dd)\n`,
  );
  console.log(`| metric         | value |`);
  console.log(`|----------------|-------|`);
  console.log(`| trades         | ${winner.n} |`);
  console.log(`| hit rate       | ${asPct(winner.hit)} |`);
  console.log(`| total PnL      | ${asSol(winner.pnlSum)} |`);
  console.log(`| mean return    | ${asPct(winner.mean)} |`);
  console.log(`| median return  | ${asPct(winner.median)} |`);
  console.log(`| best trade     | ${asPct(winner.best)} |`);
  console.log(`| worst trade    | ${asPct(winner.worst)} |`);
  console.log(`| std-dev return | ${asPct(winner.std)} |`);
  console.log(`| max drawdown   | ${asPct(winner.drawdown)} |`);
  console.log(`| avg hold       | ${(winner.avgHoldSec / 60).toFixed(1)} min |`);
  console.log(`| exit mix       | ${Object.entries(winner.exits).map(([k, v]) => `${k}:${v}`).join(", ")} |`);
  console.log(`\n**All strategies ranked by score:**\n`);
  console.log(`| strategy | score | n | hit | pnl | mean | worst | dd |`);
  console.log(`|----------|-------|---|-----|-----|------|-------|----|`);
  for (const s of stats) {
    console.log(
      `| \`${s.id}\` | ${s.score.toFixed(3)} | ${s.n} | ${asPct(s.hit)} | ${asSol(s.pnlSum)} | ${asPct(s.mean)} | ${asPct(s.worst)} | ${asPct(s.drawdown)} |`,
    );
  }

  // Per-trade detail for the winner
  const winnerTrades = byStrategy.get(winner.id)!;
  console.log(`\n**Per-trade detail (\`${winner.id}\`):**\n`);
  console.log(`| mint | dex | entry → exit | pnl | reason |`);
  console.log(`|------|-----|-------------|-----|--------|`);
  for (const t of winnerTrades.slice(0, 30)) {
    console.log(
      `| \`${t.mint.slice(0, 8)}…\` | ${t.dexKey} | ${t.entryPrice.toExponential(2)} → ${t.exitPrice.toExponential(2)} | ${asPct(t.pnlPct)} | ${t.exitReason} |`,
    );
  }
}

main();
