import { test, expect, describe } from "bun:test";
import { ConfirmationTracker } from "../lib/confirmation-tracker.ts";
import type { Strategy } from "../lib/signals.ts";
import type { PoolEvent, PriceSnap } from "../lib/types.ts";

const FAKE_MINT = "FakeMint111111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

function makeStrat(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "S8-test",
    entry: {
      minSol: 0.5,
      allowedQuoteMints: new Set([WSOL]),
    },
    exit: {
      ladderRungs: [{ profit: 0.25, sell: 1.0 }],
      holdSec: 600,
      decayN: 999,
    },
    sizeSol: () => 0.1,
    confirmationSnaps: 3,
    confirmationPct: 0.01,
    requireWsolQuote: true,
    ...overrides,
  };
}

function makePool(overrides: Partial<PoolEvent> = {}): PoolEvent {
  return {
    capturedAt: new Date().toISOString(),
    slot: 100,
    blockTime: null,
    dexKey: "meteora-damm-v2",
    programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    eventType: "INIT",
    matchedSignature: "Instruction: InitializePool",
    txSignature: "fakesig123",
    solValue: 10,
    tokens: [FAKE_MINT, WSOL],
    signer: "deployer111111111111111111111111111111111111",
    programAccounts: [],
    detectedAt: Date.now(),
    ...overrides,
  };
}

function makeSnap(overrides: Partial<PriceSnap> = {}): PriceSnap {
  return {
    takenAt: new Date().toISOString(),
    slot: 200,
    mint: FAKE_MINT,
    pool: "pool123",
    dexKey: "meteora-damm-v2",
    baseReserve: 1_000_000,
    quoteReserve: 20,
    priceQuotePerBase: 0.00002,
    quoteMint: WSOL,
    ...overrides,
  };
}

function makePlan(strat: Strategy) {
  return {
    attemptId: "attempt-1",
    traceId: "trace-1",
    strategyId: strat.id,
    mint: FAKE_MINT,
    pool: "fakesig123",
    dexKey: "meteora-damm-v2",
    sizeSol: 0.1,
    maxSlippageBps: 300,
    computeUnitLimit: 200_000,
    priorityFeeMicroLamports: 0,
    exitConfig: {
      ladderRungs: [{ profit: 0.25, sell: 1.0 }],
      holdSec: 600,
      decayN: 999,
    },
    kind: "entry" as const,
    inputMint: WSOL,
    outputMint: FAKE_MINT,
    createdAt: Date.now(),
  };
}

describe("ConfirmationTracker", () => {
  describe("needsConfirmation", () => {
    test("true for strategy with both fields set", () => {
      const strat = makeStrat();
      expect(ConfirmationTracker.needsConfirmation(strat)).toBe(true);
    });

    test("false for strategy without confirmation fields", () => {
      const strat = makeStrat({ confirmationSnaps: undefined, confirmationPct: undefined });
      expect(ConfirmationTracker.needsConfirmation(strat)).toBe(false);
    });

    test("false when confirmationSnaps is 0", () => {
      const strat = makeStrat({ confirmationSnaps: 0 });
      expect(ConfirmationTracker.needsConfirmation(strat)).toBe(false);
    });
  });

  describe("addPending", () => {
    test("accepts new mint", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat();
      const ok = tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);
      expect(ok).toBe(true);
      expect(tracker.pendingCount).toBe(1);
    });

    test("rejects duplicate mint", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat();
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);
      const ok = tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);
      expect(ok).toBe(false);
      expect(tracker.pendingCount).toBe(1);
    });

    test("respects max pending cap", () => {
      const tracker = new ConfirmationTracker(2);
      const strat = makeStrat();
      tracker.addPending("mint1", makePool(), makePlan(strat), strat);
      tracker.addPending("mint2", makePool(), makePlan(strat), strat);
      const ok = tracker.addPending("mint3", makePool(), makePlan(strat), strat);
      expect(ok).toBe(false);
      expect(tracker.pendingCount).toBe(2);
    });
  });

  describe("onPriceSnap", () => {
    test("confirms on upward momentum >= confirmationPct", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat({ confirmationPct: 0.01 }); // 1%
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      // First snap — sets base price
      const snap1 = makeSnap({ priceQuotePerBase: 0.0001 });
      let confirmed = tracker.onPriceSnap(snap1);
      expect(confirmed).toHaveLength(0);

      // Second snap — 2% up, should confirm
      const snap2 = makeSnap({ priceQuotePerBase: 0.000102, quoteReserve: 20 });
      confirmed = tracker.onPriceSnap(snap2);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.snap).toBe(snap2);
      expect(confirmed[0]!.entryPrice).toBeGreaterThan(0.000102); // slippage added
      expect(tracker.pendingCount).toBe(0);
    });

    test("expires when maxSnaps exceeded without sufficient movement", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat({ confirmationSnaps: 2, confirmationPct: 0.05 }); // 5%
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      // First snap — sets base price
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.0001 }));

      // Second snap — only 0.5% up, under threshold. Window = 2, this is snap 2
      const confirmed = tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.0001005 }));
      expect(confirmed).toHaveLength(0);
      expect(tracker.pendingCount).toBe(0); // expired
      expect(tracker.seenCount).toBe(1);
    });

    test("rejects non-WSOL quote when requireWsolQuote is true", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat({ requireWsolQuote: true });
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      // Snap with USDC quote
      const snap = makeSnap({
        priceQuotePerBase: 0.0001,
        quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });
      const confirmed = tracker.onPriceSnap(snap);
      expect(confirmed).toHaveLength(0);
      expect(tracker.pendingCount).toBe(0); // rejected
    });

    test("no-ops for unknown mints", () => {
      const tracker = new ConfirmationTracker();
      const snap = makeSnap({ mint: "unknown" });
      const confirmed = tracker.onPriceSnap(snap);
      expect(confirmed).toHaveLength(0);
    });

    test("caps position size at 0.5% of reserves", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat();
      const plan = makePlan(strat);
      plan.sizeSol = 0.1;
      tracker.addPending(FAKE_MINT, makePool(), plan, strat);

      // First snap — sets base price (tiny reserve: 2 SOL)
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.0001, quoteReserve: 2 }));

      // Second snap — 2% up with tiny reserve
      const confirmed = tracker.onPriceSnap(
        makeSnap({ priceQuotePerBase: 0.000102, quoteReserve: 2 }),
      );
      expect(confirmed).toHaveLength(1);
      // 0.5% of 2 SOL = 0.01, capped at max(0.02, 0.01) = 0.02
      expect(confirmed[0]!.plan.sizeSol).toBe(0.02);
    });

    test("does not re-enter after confirmation", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat();
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.0001 }));
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.000102 }));

      // Try to add same mint again
      const ok = tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);
      expect(ok).toBe(false);
    });

    test("ignores zero-price snaps but counts them", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat({ confirmationSnaps: 3 });
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      // Three zero-price snaps should expire
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0 }));
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0 }));
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0 }));
      expect(tracker.pendingCount).toBe(0);
    });

    test("downward movement does not confirm", () => {
      const tracker = new ConfirmationTracker();
      const strat = makeStrat({ confirmationSnaps: 3, confirmationPct: 0.01 });
      tracker.addPending(FAKE_MINT, makePool(), makePlan(strat), strat);

      // Set base price
      tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.0001 }));

      // Price drops 5% — should NOT confirm
      const confirmed = tracker.onPriceSnap(makeSnap({ priceQuotePerBase: 0.000095 }));
      expect(confirmed).toHaveLength(0);
      expect(tracker.pendingCount).toBe(1); // still pending, not expired yet
    });
  });

  describe("evictSeen", () => {
    test("evicts oldest seen entries when over maxSize", () => {
      const tracker = new ConfirmationTracker();
      // confirmationSnaps: 2 — first snap sets base price, second snap expires
      const strat = makeStrat({ confirmationSnaps: 2, confirmationPct: 0.99 });

      // Add and expire 5 mints (need 2 snaps each: base price + expiration)
      for (let i = 0; i < 5; i++) {
        const mint = `mint${i}${"0".repeat(40)}`.slice(0, 44);
        tracker.addPending(mint, makePool(), makePlan(strat), strat);
        // First snap sets base price
        tracker.onPriceSnap(makeSnap({ mint, priceQuotePerBase: 0.0001 }));
        // Second snap: doesn't meet 99% threshold, window expires
        tracker.onPriceSnap(makeSnap({ mint, priceQuotePerBase: 0.0001 }));
      }

      expect(tracker.seenCount).toBe(5);
      tracker.evictSeen(2);
      expect(tracker.seenCount).toBe(2);
    });
  });
});
