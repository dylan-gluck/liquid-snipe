#!/usr/bin/env bun
/**
 * demo.ts
 *
 * End-to-end demo of the v2 pipeline using *synthetic* captured data so it
 * runs offline. Generates:
 *
 *   data/demo/pools.jsonl    — 6 PoolEvents covering rug, runner, slow
 *                              grinder, mid-cap, graduation, drain.
 *   data/demo/prices.jsonl   — synthetic PriceSnap series per mint.
 *   data/demo/enrich/<m>.json— matching MintEnrichments.
 *
 * Then runs signals.ts list + backtest.ts against this dataset so the
 * user can see signal evaluation and per-strategy PnL on known shapes.
 *
 * Usage:
 *   bun scripts/demo.ts                # generate + report
 *   bun scripts/demo.ts --keep         # keep prior demo files (incremental)
 *   bun scripts/demo.ts --no-backtest  # only generate + signal-list
 */

import { hasFlag } from "./lib/cli.ts";
import { ANSI, color, ts } from "./lib/format.ts";
import { appendJsonl, writeJson } from "./lib/storage.ts";
import { STRATEGIES, evaluateEntry, evaluateExit } from "./lib/signals.ts";
import { STABLE_MINTS, WSOL } from "./lib/dexes.ts";
import type {
  ExitReason,
  MintEnrichment,
  PoolEvent,
  Position,
  PriceSnap,
  SimTrade,
} from "./lib/types.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";

interface Scenario {
  mint: string;
  dexKey: string;
  eventType: PoolEvent["eventType"];
  solValue: number;
  signer: string;
  /** Multipliers applied to the entry price over time, sample every 30 s. */
  trajectory: number[];
  /** Each sample's quoteReserve = baselineQuote * factor; lets X5 trigger. */
  reservesTrajectory?: number[];
  authoritiesNull: boolean;
  lpBurned: boolean;
  deployerPriorLaunches: number;
}

const SCENARIOS: Scenario[] = [
  {
    mint: "RuggMint1111111111111111111111111111111111",
    dexKey: "raydium-amm",
    eventType: "INIT",
    solValue: 8,
    signer: "RugDeployer111111111111111111111111111111",
    trajectory: [1.0, 1.1, 0.8, 0.5, 0.3, 0.15, 0.05, 0.02, 0.02],
    reservesTrajectory: [1.0, 1.0, 0.9, 0.6, 0.4, 0.2, 0.1, 0.05, 0.05],
    authoritiesNull: false, // rug: still has mint authority
    lpBurned: false,
    deployerPriorLaunches: 12,
  },
  {
    mint: "Runner111111111111111111111111111111111111",
    dexKey: "meteora-dlmm",
    eventType: "DEPOSIT",
    solValue: 50,
    signer: "GoodDeployer11111111111111111111111111111",
    trajectory: [1.0, 1.2, 1.5, 1.8, 2.5, 3.4, 4.1, 4.6, 4.2, 4.0, 3.6],
    authoritiesNull: true,
    lpBurned: true,
    deployerPriorLaunches: 1,
  },
  {
    mint: "Grinder11111111111111111111111111111111111",
    dexKey: "raydium-cpmm",
    eventType: "INIT",
    solValue: 12,
    signer: "OkDeployer11111111111111111111111111111111",
    trajectory: [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.25, 1.3, 1.32, 1.34, 1.36],
    authoritiesNull: true,
    lpBurned: false,
    deployerPriorLaunches: 3,
  },
  {
    mint: "MidCap1111111111111111111111111111111111111",
    dexKey: "raydium-amm",
    eventType: "INIT",
    solValue: 25,
    signer: "DecentDeployer11111111111111111111111111",
    trajectory: [1.0, 1.1, 1.3, 1.5, 1.8, 1.6, 1.4, 1.2, 1.1, 1.05],
    authoritiesNull: true,
    lpBurned: false,
    deployerPriorLaunches: 2,
  },
  {
    mint: "Graduate111111111111111111111111111111111",
    dexKey: "pumpfun",
    eventType: "MIGRATE",
    solValue: 17,
    signer: "PumpDeployer1111111111111111111111111111",
    trajectory: [1.0, 1.3, 1.7, 2.2, 2.5, 2.0, 1.5, 1.2, 1.0, 0.8],
    authoritiesNull: true,
    lpBurned: true,
    deployerPriorLaunches: 0,
  },
  {
    mint: "Drainer1111111111111111111111111111111111",
    dexKey: "meteora-damm-v2",
    eventType: "INIT",
    solValue: 11,
    signer: "DrainDeployer1111111111111111111111111111",
    trajectory: [1.0, 1.05, 1.1, 1.0, 0.8, 0.6, 0.3],
    reservesTrajectory: [1.0, 0.95, 0.9, 0.6, 0.3, 0.15, 0.05],
    authoritiesNull: true,
    lpBurned: false,
    deployerPriorLaunches: 0,
  },
];

const DEMO_DIR = "data/demo";
const POOLS_PATH = `${DEMO_DIR}/pools.jsonl`;
const PRICES_PATH = `${DEMO_DIR}/prices.jsonl`;
const ENRICH_DIR = `${DEMO_DIR}/enrich`;

function makeSig(seed: string): string {
  // 88-char base58-ish placeholder; only needs to be unique per pool.
  let s = seed;
  while (s.length < 88) s += "1";
  return s.slice(0, 88);
}

function generate(): void {
  if (!existsSync(DEMO_DIR)) mkdirSync(DEMO_DIR, { recursive: true });
  if (!existsSync(ENRICH_DIR)) mkdirSync(ENRICH_DIR, { recursive: true });

  // Anchor wall-clock to start of demo run.
  const t0 = Date.now();
  const sampleSec = 30;
  // Initial price = 1e-7 SOL per token; quote reserve = solValue; base
  // reserve = solValue / price. Tweak per scenario via trajectory factors.
  const basePrice = 1e-7;

  let poolIdx = 0;
  for (const sc of SCENARIOS) {
    const captureAt = new Date(t0 - 60_000 + poolIdx * 5_000).toISOString();
    const sig = makeSig(`SIG${poolIdx}_${sc.mint.slice(0, 8)}`);
    const programAccounts = [
      `${sc.mint.slice(0, 8)}vault1${"1".repeat(40)}`,
      `${sc.mint.slice(0, 8)}vault2${"1".repeat(40)}`,
    ];
    const pool: PoolEvent = {
      capturedAt: captureAt,
      slot: 1_000_000 + poolIdx * 1000,
      blockTime: Math.floor((t0 - 60_000 + poolIdx * 5_000) / 1000),
      dexKey: sc.dexKey,
      programId: "demo",
      eventType: sc.eventType,
      matchedSignature: "Instruction: Demo",
      txSignature: sig,
      solValue: sc.solValue,
      tokens: [sc.mint],
      signer: sc.signer,
      programAccounts,
    };
    appendJsonl<PoolEvent>(POOLS_PATH, pool);

    const enrichment: MintEnrichment = {
      mint: sc.mint,
      fetchedAt: new Date(t0).toISOString(),
      decimals: 6,
      supply: 1_000_000_000,
      mintAuthority: sc.authoritiesNull ? null : sc.signer,
      freezeAuthority: sc.authoritiesNull ? null : sc.signer,
      top10Concentration: sc.authoritiesNull ? 0.4 : 0.85,
      lpBurnedOrLocked: sc.lpBurned,
      deployerPriorLaunches: sc.deployerPriorLaunches,
      deployer: sc.signer,
      notes: ["demo-synthetic"],
    };
    writeJson(`${ENRICH_DIR}/${sc.mint}.json`, enrichment);

    const baselineQuote = sc.solValue;
    const baselineBase = sc.solValue / basePrice;
    for (let i = 0; i < sc.trajectory.length; i++) {
      const factor = sc.trajectory[i]!;
      const resvFactor = sc.reservesTrajectory?.[i] ?? 1;
      const takenAtMs = t0 + i * sampleSec * 1000;
      const snap: PriceSnap = {
        takenAt: new Date(takenAtMs).toISOString(),
        slot: pool.slot + 50 + i * 25,
        mint: sc.mint,
        pool: programAccounts[0]!,
        dexKey: sc.dexKey,
        baseReserve: baselineBase / Math.max(0.01, factor),
        quoteReserve: baselineQuote * resvFactor,
        priceQuotePerBase: basePrice * factor,
        quoteMint: WSOL,
      };
      appendJsonl<PriceSnap>(PRICES_PATH, snap);
    }
    poolIdx++;
  }
}

function runSignals(): void {
  const blocklist = new Set<string>();
  console.log(color(true, ANSI.bold, "=== Signal evaluation ==="));
  // Re-read what we wrote to mimic the real pipeline.
  // (Avoiding the storage helpers here would lose JSONL semantics.)
  // Use the same readJsonl helper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readJsonl, readJson } = require("./lib/storage.ts");
  const pools = readJsonl(POOLS_PATH) as PoolEvent[];
  for (const pool of pools) {
    const mint = pool.tokens.find((t) => !STABLE_MINTS.has(t))!;
    const enrichment = readJson(`${ENRICH_DIR}/${mint}.json`, null) as MintEnrichment | null;
    console.log(
      "\n" +
        color(true, ANSI.bold + ANSI.magenta, pool.dexKey.padEnd(16)) +
        ` ${pool.eventType.padEnd(8)} ${pool.solValue.toFixed(2)} SOL  mint=${mint.slice(0, 12)}…`,
    );
    for (const strat of STRATEGIES) {
      const result = evaluateEntry({ pool, enrichment, blocklist }, strat.entry);
      const ok = result.ok ? color(true, ANSI.green, "ENTER") : color(true, ANSI.red, "skip ");
      const size = strat.sizeSol(pool);
      console.log(`  ${ok} ${strat.id.padEnd(28)} size=${size.toFixed(2)} SOL`);
    }
  }
}

function runBacktest(): void {
  console.log("\n" + color(true, ANSI.bold, "=== Backtest ==="));
  const { readJsonl, readJson } = require("./lib/storage.ts");
  const pools = readJsonl(POOLS_PATH) as PoolEvent[];
  const prices = readJsonl(PRICES_PATH) as PriceSnap[];
  const blocklist = new Set<string>();
  const pricesByMint = new Map<string, PriceSnap[]>();
  for (const p of prices) {
    const arr = pricesByMint.get(p.mint) ?? [];
    arr.push(p);
    pricesByMint.set(p.mint, arr);
  }
  for (const arr of pricesByMint.values()) {
    arr.sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  }

  for (const strat of STRATEGIES) {
    const trades: SimTrade[] = [];
    for (const pool of pools) {
      const mint = pool.tokens.find((t) => !STABLE_MINTS.has(t))!;
      const enrichment = readJson(`${ENRICH_DIR}/${mint}.json`, null) as MintEnrichment | null;
      const entry = evaluateEntry({ pool, enrichment, blocklist }, strat.entry);
      if (!entry.ok) continue;
      const series = pricesByMint.get(mint) ?? [];
      const poolMs = Date.parse(pool.capturedAt);
      const idx = series.findIndex((s) => Date.parse(s.takenAt) > poolMs);
      if (idx < 0 || idx >= series.length - 1) continue;
      const entrySnap = series[idx]!;
      const rest = series.slice(idx + 1);
      const size = strat.sizeSol(pool);
      const entryPrice =
        entrySnap.priceQuotePerBase * (1 + Math.min(0.2, size / (entrySnap.quoteReserve + 1e-9)));
      const tokenAmount = (size - 0.0005) / entryPrice;
      const pos: Position = {
        strategyId: strat.id,
        poolSignature: pool.txSignature,
        mint,
        dexKey: pool.dexKey,
        entrySlot: entrySnap.slot,
        entryAt: entrySnap.takenAt,
        entryPrice,
        baselineQuoteReserve: entrySnap.quoteReserve,
        size,
        tokenAmount,
        peakPrice: entryPrice,
        realisedFrac: 0,
        realisedSol: 0,
      };
      const prev: PriceSnap[] = [entrySnap];
      let exitReason: ExitReason = "end-of-data";
      let exitPrice = entryPrice;
      for (const snap of rest) {
        if (snap.priceQuotePerBase > pos.peakPrice) pos.peakPrice = snap.priceQuotePerBase;
        const dec = evaluateExit(pos, snap, prev, strat.exit);
        if (dec.exit) {
          const slip = Math.min(0.2, (pos.size * dec.sellFraction) / (snap.quoteReserve + 1e-9));
          const fill = dec.price * (1 - slip);
          pos.realisedSol += pos.tokenAmount * dec.sellFraction * fill - 0.0005;
          pos.realisedFrac += dec.sellFraction;
          pos.tokenAmount *= 1 - dec.sellFraction;
          exitReason = dec.reason;
          exitPrice = fill;
          if (pos.realisedFrac >= 1 - 1e-9) break;
        }
        prev.push(snap);
        if (prev.length > 32) prev.shift();
      }
      if (pos.realisedFrac < 1 - 1e-9) {
        const last = rest[rest.length - 1] ?? entrySnap;
        const slip = Math.min(
          0.2,
          (pos.size * (1 - pos.realisedFrac)) / (last.quoteReserve + 1e-9),
        );
        const fill = last.priceQuotePerBase * (1 - slip);
        pos.realisedSol += pos.tokenAmount * fill;
        if (exitReason === "end-of-data") exitPrice = fill;
      }
      const pnlSol = pos.realisedSol - pos.size;
      const pnlPct = pnlSol / pos.size;
      trades.push({
        strategyId: strat.id,
        poolSignature: pool.txSignature,
        mint,
        dexKey: pool.dexKey,
        entrySlot: pos.entrySlot,
        entryAt: pos.entryAt,
        entryPrice: pos.entryPrice,
        entrySolSize: pos.size,
        exitSlot: 0,
        exitAt: new Date().toISOString(),
        exitPrice,
        exitReason,
        pnlSol,
        pnlPct,
        peakPrice: pos.peakPrice,
        durationSec: rest.length * 30,
      });
    }
    if (trades.length === 0) {
      console.log("\n" + color(true, ANSI.bold, strat.id) + "  (no entries)");
      continue;
    }
    const meanPct = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const wins = trades.filter((t) => t.pnlSol > 0).length;
    const pnlSum = trades.reduce((s, t) => s + t.pnlSol, 0);
    console.log(
      "\n" +
        color(true, ANSI.bold, strat.id) +
        `  n=${trades.length}  hit=${((wins / trades.length) * 100).toFixed(0)}%  ` +
        `mean=${(meanPct * 100).toFixed(1)}%  pnl=${pnlSum.toFixed(3)} SOL`,
    );
    for (const t of trades) {
      const colorCode = t.pnlSol >= 0 ? ANSI.green : ANSI.red;
      console.log(
        `   ${t.mint.slice(0, 10)}…  ${t.dexKey.padEnd(16)}  ` +
          color(true, colorCode, `pnl=${(t.pnlPct * 100).toFixed(1)}%`) +
          `  reason=${t.exitReason}`,
      );
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (!hasFlag(argv, "--keep")) {
    for (const path of [POOLS_PATH, PRICES_PATH]) {
      if (existsSync(path)) rmSync(path);
    }
    if (existsSync(ENRICH_DIR)) {
      rmSync(ENRICH_DIR, { recursive: true, force: true });
      mkdirSync(ENRICH_DIR, { recursive: true });
    }
  }

  console.log(color(true, ANSI.dim, `[${ts()}] generating synthetic data → ${DEMO_DIR}/`));
  generate();
  runSignals();
  if (!hasFlag(argv, "--no-backtest")) runBacktest();
}

main();
