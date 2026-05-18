#!/usr/bin/env bun
/**
 * snipe-bench.ts — Synthetic latency benchmark.
 * Generates N fake PoolEvents and measures decision pipeline timing.
 */
import { DecisionEngine } from "../lib/decision.ts";
import { AppConfigSchema } from "../lib/config.ts";
import { STRATEGIES } from "../lib/signals.ts";
import { DEXES, WSOL } from "../lib/dexes.ts";
import type { PoolEvent, MintEnrichment, SafetyVerdict } from "../lib/types.ts";

// ── CLI ─────────────────────────────────────────────────────────────

const nArg = process.argv.find((a) => a.startsWith("--n"));
const N = nArg
  ? parseInt(nArg.split("=")[1] ?? process.argv[process.argv.indexOf(nArg) + 1] ?? "100", 10)
  : 100;

// ── Config with default strategies ──────────────────────────────────

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
    sizeSol: 0.5,
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

// ── Synthetic data ──────────────────────────────────────────────────

function fakeMint(len = 44): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[(Math.random() * chars.length) | 0];
  }
  return out;
}

function generatePool(i: number): PoolEvent {
  const dex = DEXES[i % DEXES.length]!;
  const eventTypes = dex.events.map((e) => e.type);
  const eventType = eventTypes[i % eventTypes.length] ?? "INIT";
  const solValue = 0.5 + Math.random() * 100;
  const mint = fakeMint();
  const firstEvent = dex.events[0];
  const matchedSig = firstEvent ? (firstEvent.signatures[0] ?? "unknown") : "unknown";

  return {
    capturedAt: new Date().toISOString(),
    slot: 250_000_000 + i,
    blockTime: (Date.now() / 1000) | 0,
    dexKey: dex.key,
    programId: dex.programId,
    eventType,
    matchedSignature: matchedSig,
    txSignature: fakeMint(88),
    solValue,
    tokens: [mint, WSOL],
    signer: fakeMint(),
    programAccounts: [fakeMint(), fakeMint()],
    detectedAt: Date.now(),
  };
}

function passingVerdict(enrichment: MintEnrichment | null): SafetyVerdict {
  return {
    pass: true,
    checks: [
      { name: "mint-authority", pass: true, reason: "renounced", durationMs: 0 },
      { name: "freeze-authority", pass: true, reason: "renounced", durationMs: 0 },
    ],
    totalDurationMs: 0,
    enrichment,
  };
}

function fakeEnrichment(mint: string): MintEnrichment {
  return {
    mint,
    fetchedAt: new Date().toISOString(),
    decimals: 9,
    supply: 1_000_000_000,
    mintAuthority: null,
    freezeAuthority: null,
    top10Concentration: 0.3,
    lpBurnedOrLocked: true,
    deployerPriorLaunches: 0,
    deployer: fakeMint(),
    notes: [],
  };
}

// ── Percentile helper ───────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ── Benchmark ───────────────────────────────────────────────────────

function main() {
  console.log(`snipe-bench: generating ${N} synthetic PoolEvents…\n`);

  const config = buildConfig();
  const engine = new DecisionEngine(config);
  const openPositions = new Map<string, number>();
  const latencies: number[] = [];
  let fires = 0;

  const pools: PoolEvent[] = [];
  for (let i = 0; i < N; i++) {
    pools.push(generatePool(i));
  }

  for (const pool of pools) {
    const mint = pool.tokens[0] ?? "unknown";
    const enrichment = fakeEnrichment(mint);
    const safety = passingVerdict(enrichment);

    const t0 = performance.now();
    const outcomes = engine.evaluate(pool, enrichment, safety, openPositions);
    const elapsed = performance.now() - t0;
    latencies.push(elapsed);

    for (const o of outcomes) {
      if (o.fire) fires++;
    }
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;

  console.log(`── Results (${N} evaluations, ${fires} fires) ──`);
  console.log(`  Min:  ${min.toFixed(3)} ms`);
  console.log(`  P50:  ${p50.toFixed(3)} ms`);
  console.log(`  P95:  ${p95.toFixed(3)} ms`);
  console.log(`  Max:  ${max.toFixed(3)} ms`);
  console.log(`  Mean: ${mean.toFixed(3)} ms`);

  if (p95 >= 50) {
    console.error(`\n✗ P95 (${p95.toFixed(3)} ms) exceeds 50 ms threshold`);
    process.exit(1);
  }

  console.log(`\n✓ P95 under 50 ms — benchmark passed`);
}

main();
