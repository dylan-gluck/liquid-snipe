import { test, expect, describe } from "bun:test";
import { DecisionEngine } from "../lib/decision.ts";
import type { AppConfig, StrategyConfig } from "../lib/config.ts";
import type { PoolEvent, MintEnrichment, SafetyVerdict } from "../lib/types.ts";
import { AppConfigSchema } from "../lib/config.ts";

// ── Fixtures ───────────────────────────────────────────────────────

const FAKE_MINT = "FakeMint111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

const testStrategy: StrategyConfig = {
  id: "test-strat",
  enabled: true,
  minSol: 5,
  requireMintSanity: true,
  requireGraduation: false,
  sizeSol: 0.5,
  maxSlippageBps: 250,
  maxFeeLamports: 100_000,
  maxSimultaneousPositions: 3,
  exit: {},
};

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = AppConfigSchema.parse({});
  return { ...base, strategies: [testStrategy], ...overrides };
}

function makePool(overrides: Partial<PoolEvent> = {}): PoolEvent {
  return {
    capturedAt: new Date().toISOString(),
    slot: 100,
    blockTime: null,
    dexKey: "raydium-v4",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    eventType: "INIT",
    matchedSignature: "initialize2",
    txSignature: "fakesig123",
    solValue: 10,
    tokens: [FAKE_MINT, WSOL],
    signer: "deployer111111111111111111111111111111111111",
    programAccounts: [],
    detectedAt: Date.now(),
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<MintEnrichment> = {}): MintEnrichment {
  return {
    mint: FAKE_MINT,
    fetchedAt: new Date().toISOString(),
    decimals: 9,
    supply: 1_000_000_000,
    mintAuthority: null,
    freezeAuthority: null,
    top10Concentration: 0.3,
    lpBurnedOrLocked: true,
    deployerPriorLaunches: 0,
    deployer: "deployer111111111111111111111111111111111111",
    notes: [],
    ...overrides,
  };
}

function makeSafety(pass: boolean): SafetyVerdict {
  return {
    pass,
    checks: [{ name: "rugcheck", pass, reason: pass ? "ok" : "flagged", durationMs: 5 }],
    totalDurationMs: 5,
    enrichment: null,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("DecisionEngine", () => {
  test("returns fire=true when entry passes and safety passes", () => {
    const engine = new DecisionEngine(makeConfig());
    const results = engine.evaluate(makePool(), makeEnrichment(), makeSafety(true), new Map());
    expect(results).toHaveLength(1);
    expect(results[0]!.fire).toBe(true);
    expect(results[0]!.strategyId).toBe("test-strat");
    expect(results[0]!.plan).not.toBeNull();
  });

  test("returns fire=false when safety fails", () => {
    const engine = new DecisionEngine(makeConfig());
    const results = engine.evaluate(makePool(), makeEnrichment(), makeSafety(false), new Map());
    expect(results).toHaveLength(1);
    expect(results[0]!.fire).toBe(false);
    expect(results[0]!.blocked).toBe("safety");
    expect(results[0]!.plan).toBeNull();
  });

  test("returns fire=false when entry rules reject (pool below minSol)", () => {
    const engine = new DecisionEngine(makeConfig());
    const results = engine.evaluate(
      makePool({ solValue: 2 }), // below minSol=5
      makeEnrichment(),
      makeSafety(true),
      new Map(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.fire).toBe(false);
    expect(results[0]!.plan).toBeNull();
    expect(results[0]!.reasons.some((r) => r.includes("E2"))).toBe(true);
  });

  test("respects maxSimultaneousPositions", () => {
    const engine = new DecisionEngine(makeConfig());
    const counts = new Map([["test-strat", 3]]); // at limit of 3
    const results = engine.evaluate(makePool(), makeEnrichment(), makeSafety(true), counts);
    expect(results).toHaveLength(1);
    expect(results[0]!.fire).toBe(false);
    expect(results[0]!.blocked).toContain("max_positions");
  });

  test("disabled strategies are skipped", () => {
    const disabledStrat: StrategyConfig = { ...testStrategy, id: "disabled", enabled: false };
    const config = makeConfig({ strategies: [disabledStrat] });
    const engine = new DecisionEngine(config);
    const results = engine.evaluate(makePool(), makeEnrichment(), makeSafety(true), new Map());
    expect(results).toHaveLength(0);
  });

  test("uses sizeByLiquidity tiers when present", () => {
    const tiered: StrategyConfig = {
      ...testStrategy,
      id: "tiered",
      sizeSol: 0.1, // fallback
      sizeByLiquidity: [
        { minSol: 50, size: 2.0 },
        { minSol: 20, size: 1.0 },
        { minSol: 5, size: 0.5 },
      ],
    };
    const config = makeConfig({ strategies: [tiered] });
    const engine = new DecisionEngine(config);

    // Pool with 25 SOL should match the 20-SOL tier → size 1.0
    const results = engine.evaluate(
      makePool({ solValue: 25 }),
      makeEnrichment(),
      makeSafety(true),
      new Map(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.fire).toBe(true);
    expect(results[0]!.plan!.sizeSol).toBe(1.0);

    // Pool with 100 SOL should match the 50-SOL tier → size 2.0
    const results2 = engine.evaluate(
      makePool({ solValue: 100 }),
      makeEnrichment(),
      makeSafety(true),
      new Map(),
    );
    expect(results2[0]!.plan!.sizeSol).toBe(2.0);

    // Pool with 6 SOL should match the 5-SOL tier → size 0.5
    const results3 = engine.evaluate(
      makePool({ solValue: 6 }),
      makeEnrichment(),
      makeSafety(true),
      new Map(),
    );
    expect(results3[0]!.plan!.sizeSol).toBe(0.5);
  });

  test("generates valid TradePlan on fire", () => {
    const engine = new DecisionEngine(makeConfig());
    const pool = makePool();
    const results = engine.evaluate(pool, makeEnrichment(), makeSafety(true), new Map());
    expect(results[0]!.fire).toBe(true);
    const plan = results[0]!.plan!;

    expect(plan.strategyId).toBe("test-strat");
    expect(plan.mint).toBe(FAKE_MINT);
    expect(plan.pool).toBe(pool.txSignature);
    expect(plan.dexKey).toBe(pool.dexKey);
    expect(plan.sizeSol).toBe(0.5);
    expect(plan.maxSlippageBps).toBe(250);
    expect(plan.kind).toBe("entry");
    expect(plan.inputMint).toBe(WSOL);
    expect(plan.outputMint).toBe(FAKE_MINT);
    expect(typeof plan.attemptId).toBe("string");
    expect(typeof plan.traceId).toBe("string");
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.computeUnitLimit).toBe(200_000);
  });
});
