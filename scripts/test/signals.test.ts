import { test, expect, describe } from "bun:test";
import {
  e1FirstLiquidity,
  e2SizeGate,
  e3MintSanity,
  e4LpLocked,
  e5Graduation,
  e6DeployerRep,
  e7QuoteWhitelist,
  evaluateEntry,
  evaluateExit,
} from "../lib/signals.ts";
import type { EntryContext, EntryConfig, ExitConfig } from "../lib/signals.ts";
import type { PoolEvent, MintEnrichment, Position, PriceSnap } from "../lib/types.ts";
import { WSOL } from "../lib/dexes.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function mkPool(overrides: Partial<PoolEvent> = {}): PoolEvent {
  return {
    capturedAt: "2025-01-01T00:00:00Z",
    slot: 1000,
    blockTime: null,
    dexKey: "raydium",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    eventType: "INIT",
    matchedSignature: "initialize2",
    txSignature: "sig1",
    solValue: 5,
    tokens: ["MINTabc123"],
    signer: "deployer1",
    programAccounts: [],
    ...overrides,
  };
}

function mkEnrichment(overrides: Partial<MintEnrichment> = {}): MintEnrichment {
  return {
    mint: "MINTabc123",
    fetchedAt: "2025-01-01T00:00:00Z",
    decimals: 9,
    supply: 1e9,
    mintAuthority: null,
    freezeAuthority: null,
    top10Concentration: 0.3,
    lpBurnedOrLocked: true,
    deployerPriorLaunches: 0,
    deployer: "deployer1",
    notes: [],
    ...overrides,
  };
}

function mkCtx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    pool: mkPool(),
    enrichment: mkEnrichment(),
    blocklist: new Set<string>(),
    ...overrides,
  };
}

function mkPosition(overrides: Partial<Position> = {}): Position {
  return {
    strategyId: "S1",
    poolSignature: "sig1",
    mint: "MINTabc123",
    dexKey: "raydium",
    entrySlot: 1000,
    entryAt: "2025-01-01T00:00:00Z",
    entryPrice: 1.0,
    baselineQuoteReserve: 100,
    size: 1,
    tokenAmount: 1,
    peakPrice: 1.5,
    realisedFrac: 0,
    realisedSol: 0,
    ...overrides,
  };
}

function mkSnap(overrides: Partial<PriceSnap> = {}): PriceSnap {
  return {
    takenAt: "2025-01-01T00:05:00Z",
    slot: 1100,
    mint: "MINTabc123",
    pool: "pool1",
    dexKey: "raydium",
    baseReserve: 1000,
    quoteReserve: 100,
    priceQuotePerBase: 1.2,
    quoteMint: WSOL,
    ...overrides,
  };
}

// ─── Entry Signals ────────────────────────────────────────────────

describe("entry signals", () => {
  const e1Cases: Array<[string, Partial<PoolEvent>, boolean]> = [
    ["INIT passes", { eventType: "INIT" }, true],
    ["DEPOSIT passes", { eventType: "DEPOSIT" }, true],
    ["CREATE passes", { eventType: "CREATE" }, true],
    ["MIGRATE passes", { eventType: "MIGRATE" }, true],
  ];

  for (const [label, poolOverride, expected] of e1Cases) {
    test(`E1: ${label}`, () => {
      const ctx = mkCtx({ pool: mkPool(poolOverride) });
      expect(e1FirstLiquidity(ctx).ok).toBe(expected);
    });
  }

  // E1 unknown type — force an invalid value
  test("E1: unknown type fails", () => {
    const ctx = mkCtx({ pool: mkPool({ eventType: "BOGUS" as any }) });
    expect(e1FirstLiquidity(ctx).ok).toBe(false);
  });

  describe("E2 size gate", () => {
    const cases: Array<[string, number, number, boolean]> = [
      ["exactly at threshold passes", 5, 5, true],
      ["above threshold passes", 10, 5, true],
      ["below threshold fails", 3, 5, false],
    ];
    for (const [label, solValue, minSol, expected] of cases) {
      test(label, () => {
        const ctx = mkCtx({ pool: mkPool({ solValue }) });
        expect(e2SizeGate(ctx, minSol).ok).toBe(expected);
      });
    }
  });

  describe("E3 mint sanity", () => {
    test("both null passes", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ mintAuthority: null, freezeAuthority: null }),
      });
      expect(e3MintSanity(ctx).ok).toBe(true);
    });

    test("mintAuthority set fails", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ mintAuthority: "someAuth" }),
      });
      expect(e3MintSanity(ctx).ok).toBe(false);
    });

    test("freezeAuthority set fails", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ freezeAuthority: "someAuth" }),
      });
      expect(e3MintSanity(ctx).ok).toBe(false);
    });

    test("no enrichment fails", () => {
      const ctx = mkCtx({ enrichment: undefined });
      expect(e3MintSanity(ctx).ok).toBe(false);
    });
  });

  describe("E4 LP locked", () => {
    test("lpBurnedOrLocked=true passes", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ lpBurnedOrLocked: true }),
      });
      expect(e4LpLocked(ctx).ok).toBe(true);
    });

    test("lpBurnedOrLocked=false fails", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ lpBurnedOrLocked: false }),
      });
      expect(e4LpLocked(ctx).ok).toBe(false);
    });

    test("no enrichment fails", () => {
      const ctx = mkCtx({ enrichment: undefined });
      expect(e4LpLocked(ctx).ok).toBe(false);
    });
  });

  describe("E5 graduation", () => {
    test("pumpfun + MIGRATE passes", () => {
      const ctx = mkCtx({
        pool: mkPool({ dexKey: "pumpfun", eventType: "MIGRATE" }),
      });
      expect(e5Graduation(ctx).ok).toBe(true);
    });

    test("other dex fails", () => {
      const ctx = mkCtx({
        pool: mkPool({ dexKey: "raydium", eventType: "MIGRATE" }),
      });
      expect(e5Graduation(ctx).ok).toBe(false);
    });

    test("pumpfun + non-MIGRATE fails", () => {
      const ctx = mkCtx({
        pool: mkPool({ dexKey: "pumpfun", eventType: "INIT" }),
      });
      expect(e5Graduation(ctx).ok).toBe(false);
    });
  });

  describe("E6 deployer rep", () => {
    test("not on blocklist passes", () => {
      const ctx = mkCtx({ blocklist: new Set<string>() });
      expect(e6DeployerRep(ctx, undefined).ok).toBe(true);
    });

    test("on blocklist fails", () => {
      const ctx = mkCtx({
        pool: mkPool({ signer: "badguy" }),
        blocklist: new Set(["badguy"]),
      });
      expect(e6DeployerRep(ctx, undefined).ok).toBe(false);
    });

    test("prior launches above cap fails", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ deployerPriorLaunches: 10 }),
      });
      expect(e6DeployerRep(ctx, 5).ok).toBe(false);
    });

    test("prior launches within cap passes", () => {
      const ctx = mkCtx({
        enrichment: mkEnrichment({ deployerPriorLaunches: 3 }),
      });
      expect(e6DeployerRep(ctx, 5).ok).toBe(true);
    });
  });

  describe("E7 quote whitelist", () => {
    test("non-stable token + stable in whitelist passes", () => {
      const ctx = mkCtx({ pool: mkPool({ tokens: ["MINTabc123"] }) });
      const allowed = new Set([WSOL]);
      expect(e7QuoteWhitelist(ctx, allowed).ok).toBe(true);
    });

    test("all stables (empty tokens) fails", () => {
      const ctx = mkCtx({ pool: mkPool({ tokens: [] }) });
      const allowed = new Set([WSOL]);
      expect(e7QuoteWhitelist(ctx, allowed).ok).toBe(false);
    });

    test("no allowed quote fails", () => {
      const ctx = mkCtx({ pool: mkPool({ tokens: ["MINTabc123"] }) });
      const allowed = new Set(["randomMint"]);
      expect(e7QuoteWhitelist(ctx, allowed).ok).toBe(false);
    });
  });

  describe("evaluateEntry", () => {
    const baseCfg: EntryConfig = {
      minSol: 3,
      allowedQuoteMints: new Set([WSOL]),
      requireMintSanity: true,
      requireGraduation: false,
      maxDeployerPriorLaunches: undefined,
    };

    test("ok=true when all pass", () => {
      const ctx = mkCtx({
        pool: mkPool({ solValue: 5, eventType: "INIT", tokens: ["MINT1"] }),
        enrichment: mkEnrichment({ mintAuthority: null, freezeAuthority: null }),
      });
      const result = evaluateEntry(ctx, baseCfg);
      expect(result.ok).toBe(true);
      expect(result.fired.length).toBeGreaterThan(0);
    });

    test("ok=false when E2 fails", () => {
      const ctx = mkCtx({
        pool: mkPool({ solValue: 1, eventType: "INIT", tokens: ["MINT1"] }),
        enrichment: mkEnrichment(),
      });
      const result = evaluateEntry(ctx, baseCfg);
      expect(result.ok).toBe(false);
      expect(result.reasons.some((r) => r.startsWith("E2"))).toBe(true);
    });

    test("ok=false when E3 fails", () => {
      const ctx = mkCtx({
        pool: mkPool({ solValue: 5, eventType: "INIT", tokens: ["MINT1"] }),
        enrichment: mkEnrichment({ mintAuthority: "auth" }),
      });
      const result = evaluateEntry(ctx, baseCfg);
      expect(result.ok).toBe(false);
      expect(result.reasons.some((r) => r.startsWith("E3"))).toBe(true);
    });
  });
});

// ─── Exit Signals ─────────────────────────────────────────────────

describe("exit signals", () => {
  test("X4 stop loss triggers", () => {
    // entry=1.0, snap price=0.6 → ret=-0.4, stopPct=-0.3
    const pos = mkPosition({ entryPrice: 1.0, peakPrice: 1.0 });
    const snap = mkSnap({ priceQuotePerBase: 0.6, takenAt: "2025-01-01T00:01:00Z" });
    const cfg: ExitConfig = { stopPct: -0.3 };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("stop");
      expect(result.sellFraction).toBe(1);
    }
  });

  test("X1 ladder partial triggers at rung", () => {
    // entry=1.0, snap=1.6 → ret=0.6, rung at profit=0.5 sell=0.5
    const pos = mkPosition({ entryPrice: 1.0, peakPrice: 1.6, realisedFrac: 0 });
    const snap = mkSnap({ priceQuotePerBase: 1.6, takenAt: "2025-01-01T00:01:00Z" });
    const cfg: ExitConfig = {
      ladderRungs: [
        { profit: 0.5, sell: 0.5 },
        { profit: 1.0, sell: 0.5 },
      ],
    };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("ladder-partial");
      expect(result.sellFraction).toBe(0.5);
    }
  });

  test("X2 trailing stop triggers on drop from peak", () => {
    // entry=1.0, peak=2.0, snap=1.5 → ret=0.5>0, drop=(2.0-1.5)/2.0=0.25
    const pos = mkPosition({ entryPrice: 1.0, peakPrice: 2.0 });
    const snap = mkSnap({ priceQuotePerBase: 1.5, takenAt: "2025-01-01T00:01:00Z" });
    const cfg: ExitConfig = { trailPct: 0.2 };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("trail");
    }
  });

  test("X2 trailing stop does not trigger when not in profit", () => {
    // entry=1.0, peak=1.2, snap=0.9 → ret=-0.1 (not in profit)
    const pos = mkPosition({ entryPrice: 1.0, peakPrice: 1.2 });
    const snap = mkSnap({ priceQuotePerBase: 0.9, takenAt: "2025-01-01T00:01:00Z" });
    const cfg: ExitConfig = { trailPct: 0.2 };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(false);
  });

  test("X3 time exit triggers when elapsed > holdSec", () => {
    const pos = mkPosition({ entryAt: "2025-01-01T00:00:00Z" });
    const snap = mkSnap({
      priceQuotePerBase: 1.0,
      takenAt: "2025-01-01T00:10:00Z", // 600s elapsed
    });
    const cfg: ExitConfig = { holdSec: 300 };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("time");
    }
  });

  test("X5 drain triggers when quoteReserve below threshold", () => {
    const pos = mkPosition({ baselineQuoteReserve: 100 });
    const snap = mkSnap({
      quoteReserve: 10,
      priceQuotePerBase: 1.0,
      takenAt: "2025-01-01T00:01:00Z",
    });
    const cfg: ExitConfig = { drainPct: 0.5 };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("drain");
    }
  });

  test("X7 decay triggers after N consecutive non-positive samples", () => {
    const pos = mkPosition({ entryPrice: 1.0 });
    // 3 prev snaps + current snap, all declining
    const prevSnaps: PriceSnap[] = [
      mkSnap({ priceQuotePerBase: 1.0, takenAt: "2025-01-01T00:01:00Z" }),
      mkSnap({ priceQuotePerBase: 0.99, takenAt: "2025-01-01T00:02:00Z" }),
      mkSnap({ priceQuotePerBase: 0.98, takenAt: "2025-01-01T00:03:00Z" }),
    ];
    const snap = mkSnap({ priceQuotePerBase: 0.97, takenAt: "2025-01-01T00:04:00Z" });
    const cfg: ExitConfig = { decayN: 3 };
    const result = evaluateExit(pos, snap, prevSnaps, cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("decay");
    }
  });

  test("priority: stop > ladder > trail > drain > decay > time", () => {
    // Set up all triggers at once; stop should win
    const pos = mkPosition({
      entryPrice: 1.0,
      peakPrice: 2.0,
      baselineQuoteReserve: 100,
      entryAt: "2025-01-01T00:00:00Z",
      realisedFrac: 0,
    });
    // price=0.5 → ret=-0.5 (stop at -0.3), drain=(100→5), time=600s>300
    const snap = mkSnap({
      priceQuotePerBase: 0.5,
      quoteReserve: 5,
      takenAt: "2025-01-01T00:10:00Z",
    });
    const prevSnaps = [
      mkSnap({ priceQuotePerBase: 0.6, takenAt: "2025-01-01T00:07:00Z" }),
      mkSnap({ priceQuotePerBase: 0.55, takenAt: "2025-01-01T00:08:00Z" }),
      mkSnap({ priceQuotePerBase: 0.52, takenAt: "2025-01-01T00:09:00Z" }),
    ];
    const cfg: ExitConfig = {
      stopPct: -0.3,
      ladderRungs: [{ profit: 0.5, sell: 0.5 }],
      trailPct: 0.2,
      holdSec: 300,
      drainPct: 0.5,
      decayN: 3,
    };
    const result = evaluateExit(pos, snap, prevSnaps, cfg);
    expect(result.exit).toBe(true);
    if (result.exit) {
      expect(result.reason).toBe("stop");
    }
  });

  test("no exit when nothing triggers", () => {
    const pos = mkPosition({
      entryPrice: 1.0,
      peakPrice: 1.1,
      baselineQuoteReserve: 100,
      entryAt: "2025-01-01T00:00:00Z",
    });
    // price=1.05 → ret=0.05, within bounds
    const snap = mkSnap({
      priceQuotePerBase: 1.05,
      quoteReserve: 90,
      takenAt: "2025-01-01T00:01:00Z",
    });
    const cfg: ExitConfig = {
      stopPct: -0.3,
      trailPct: 0.2,
      holdSec: 600,
      drainPct: 0.1,
    };
    const result = evaluateExit(pos, snap, [], cfg);
    expect(result.exit).toBe(false);
  });
});
