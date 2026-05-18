#!/usr/bin/env bun
/**
 * replay-live.ts — Replays data/pools-combined.jsonl through the live
 * decision engine and asserts decisions match the backtest.
 */
import { readJsonl } from "../lib/storage.ts";
import { STABLE_MINTS } from "../lib/dexes.ts";
import { DecisionEngine } from "../lib/decision.ts";
import { AppConfigSchema } from "../lib/config.ts";
import { STRATEGIES } from "../lib/signals.ts";
import type { PoolEvent, MintEnrichment, SimTrade } from "../lib/types.ts";
import type { SafetyVerdict } from "../lib/types.ts";
import { readJson } from "../lib/storage.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Paths ───────────────────────────────────────────────────────────

const DATA_DIR = join(import.meta.dir, "../../data");
const POOLS_PATH = join(DATA_DIR, "pools-combined.jsonl");
const TRADES_PATH = join(DATA_DIR, "trades.jsonl");
const ENRICH_DIR = join(DATA_DIR, "enrich");

// ── Helpers ─────────────────────────────────────────────────────────

function loadEnrichment(mint: string): MintEnrichment | null {
  const path = join(ENRICH_DIR, `${mint}.json`);
  if (!existsSync(path)) return null;
  return readJson<MintEnrichment | null>(path, null);
}

function buildSafetyVerdict(enrichment: MintEnrichment | null): SafetyVerdict {
  // E3: mint authority and freeze authority renounced
  const mintPass = !enrichment || enrichment.mintAuthority === null;
  const freezePass = !enrichment || enrichment.freezeAuthority === null;
  const pass = mintPass && freezePass;

  return {
    pass,
    checks: [
      {
        name: "mint-authority",
        pass: mintPass,
        reason: mintPass ? "renounced" : "active",
        durationMs: 0,
      },
      {
        name: "freeze-authority",
        pass: freezePass,
        reason: freezePass ? "renounced" : "active",
        durationMs: 0,
      },
    ],
    totalDurationMs: 0,
    enrichment,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ── Build config with all 5 default strategies ──────────────────────

function buildConfig() {
  const stratConfigs = STRATEGIES.map((s) => ({
    id: s.id,
    enabled: s.enabled !== false,
    minSol: s.entry.minSol ?? 1,
    allowedTypes: s.entry.allowedTypes as string[] | undefined,
    requireMintSanity: s.entry.requireMintSanity ?? true,
    requireGraduation: s.entry.requireGraduation ?? false,
    maxDeployerPriorLaunches: s.entry.maxDeployerPriorLaunches,
    allowedQuoteMints: s.entry.allowedQuoteMints ? [...s.entry.allowedQuoteMints] : undefined,
    sizeSol: typeof s.sizeSol === "function" ? 0.5 : 0.5,
    maxSlippageBps: s.maxSlippageBps ?? 250,
    maxFeeLamports: s.maxFeeLamports ?? 100_000,
    maxSimultaneousPositions: s.maxSimultaneousPositions ?? 3,
    exit: {
      ladderRungs: s.exit.ladderRungs,
      trailPct: s.exit.trailPct,
      holdSec: s.exit.holdSec,
      stopPct: s.exit.stopPct,
      drainPct: s.exit.drainPct,
      decayN: s.exit.decayN,
    },
  }));

  return AppConfigSchema.parse({ strategies: stratConfigs });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // Gracefully handle missing data
  if (!existsSync(POOLS_PATH)) {
    console.warn(`⚠  ${POOLS_PATH} not found — skipping replay (run capture first)`);
    process.exit(0);
  }

  const pools = readJsonl<PoolEvent>(POOLS_PATH);
  console.log(`Loaded ${pools.length} pool events`);

  // Load backtest trades for parity comparison
  const backtestTrades: SimTrade[] = existsSync(TRADES_PATH)
    ? readJsonl<SimTrade>(TRADES_PATH)
    : [];
  console.log(`Loaded ${backtestTrades.length} backtest trades`);

  // Build expected fire set: strategyId -> Set<txSignature>
  const expectedFires = new Map<string, Set<string>>();
  for (const t of backtestTrades) {
    let set = expectedFires.get(t.strategyId);
    if (!set) {
      set = new Set();
      expectedFires.set(t.strategyId, set);
    }
    set.add(t.poolSignature);
  }

  // Run decision engine
  const config = buildConfig();
  const engine = new DecisionEngine(config);
  const openPositions = new Map<string, number>();
  const latencies: number[] = [];

  // Actual fire set: strategyId -> Set<txSignature>
  const actualFires = new Map<string, Set<string>>();
  let totalFires = 0;

  for (const pool of pools) {
    // Get the non-stable mint for enrichment lookup
    const mint = pool.tokens.find((t) => !STABLE_MINTS.has(t));
    const enrichment = mint ? loadEnrichment(mint) : null;
    const safety = buildSafetyVerdict(enrichment);

    const t0 = performance.now();
    const outcomes = engine.evaluate(pool, enrichment, safety, openPositions);
    const elapsed = performance.now() - t0;
    latencies.push(elapsed);

    for (const o of outcomes) {
      if (o.fire) {
        totalFires++;
        let set = actualFires.get(o.strategyId);
        if (!set) {
          set = new Set();
          actualFires.set(o.strategyId, set);
        }
        set.add(pool.txSignature);
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────

  console.log(`\n── Decision engine results ──`);
  console.log(`Total fires: ${totalFires}`);

  const allStratIds = new Set([...expectedFires.keys(), ...actualFires.keys()]);

  let missingCount = 0;

  for (const sid of [...allStratIds].sort()) {
    const expected = expectedFires.get(sid) ?? new Set();
    const actual = actualFires.get(sid) ?? new Set();

    // Superset check: every backtest fire must also fire in the live engine.
    // Extra fires are expected (backtest additionally filters by price data).
    const missing = [...expected].filter((s) => !actual.has(s));
    const extra = [...actual].filter((s) => !expected.has(s));

    const icon = missing.length === 0 ? "✓" : "✗";

    console.log(
      `  ${icon} ${sid}: backtest=${expected.size} live=${actual.size} (extra=${extra.length} ok)`,
    );

    if (missing.length > 0) {
      console.log(
        `      MISSING (${missing.length}): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
      );
      missingCount += missing.length;
    }
  }

  // ── Latency ───────────────────────────────────────────────────────

  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);

  console.log(`\n── Latency (${latencies.length} evaluations) ──`);
  console.log(`  P50: ${p50.toFixed(3)} ms`);
  console.log(`  P95: ${p95.toFixed(3)} ms`);

  // ── Exit code ─────────────────────────────────────────────────────

  if (backtestTrades.length === 0) {
    console.log(`\n⚠  No backtest trades found — skipping parity assertion`);
    process.exit(0);
  }

  if (missingCount > 0) {
    console.error(`\n✗ ${missingCount} backtest fires NOT reproduced — exiting 1`);
    process.exit(1);
  }

  console.log(`\n✓ Parity holds — all backtest fires reproduced`);
  process.exit(0);
}

void main();
