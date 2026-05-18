import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { RiskGuard } from "../lib/risk-guard.ts";
import { openDb, runMigrations, closeDb } from "../lib/db.ts";
import type { RiskConfig } from "../lib/config.ts";

const defaultRiskConfig: RiskConfig = {
  dailyMaxLossSol: 5,
  maxSimFailures: 3,
  maxRpcErrorRate: 0.05,
  maxSlotLag: 5,
  perBlockCapSol: 2,
};

describe("RiskGuard", () => {
  let guard: RiskGuard;

  beforeEach(() => {
    closeDb();
    openDb(":memory:");
    runMigrations(openDb(":memory:"));
    guard = new RiskGuard(defaultRiskConfig);
  });

  afterEach(() => {
    closeDb();
  });

  test("allows trade when all checks pass", () => {
    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("blocks when daily loss exceeds limit", () => {
    // Post two losing trades totalling -5.5 SOL (exceeds -5 limit)
    guard.postTrade(-3, false);
    guard.postTrade(-2.5, false);

    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("daily loss limit reached");
  });

  test("blocks after 3 consecutive sim failures", () => {
    guard.postTrade(0, true);
    guard.postTrade(0, true);
    guard.postTrade(0, true);

    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sim failure limit reached");
  });

  test("resets sim failures on success", () => {
    guard.postTrade(0, true);
    guard.postTrade(0, true);
    // A successful trade resets the counter
    guard.postTrade(0, false);

    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(true);
  });

  test("blocks when halted", () => {
    guard.tripCircuitBreaker("manual halt");

    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("halted");
  });

  test("resumes after resetCircuitBreaker", () => {
    guard.tripCircuitBreaker("test");
    expect(guard.preTrade("strat-a", 1, true).allowed).toBe(false);

    guard.resetCircuitBreaker();
    const result = guard.preTrade("strat-a", 1, true);
    expect(result.allowed).toBe(true);
  });

  test("blocks when RPC unhealthy", () => {
    const result = guard.preTrade("strat-a", 1, false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("RPC unhealthy");
  });

  test("isHalted reflects state", () => {
    expect(guard.isHalted()).toBe(false);

    guard.tripCircuitBreaker("test");
    expect(guard.isHalted()).toBe(true);

    guard.resetCircuitBreaker();
    expect(guard.isHalted()).toBe(false);
  });
});
