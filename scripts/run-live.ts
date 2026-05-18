#!/usr/bin/env bun
/**
 * run-live.ts — Single entrypoint for the live trading runtime.
 *
 * Loads config, opens DB + RPC pool + Detection bus + Safety + Decision +
 * TxEngine + Position manager + Risk guard + Metrics + Kill-switch.
 *
 * Usage:
 *   bun scripts/run-live.ts --mode shadow   # Gate 1: no real txs
 *   bun scripts/run-live.ts --mode live      # Gate 2: real execution
 *   bun scripts/run-live.ts --config path    # custom config file
 */

import { address, type Signature } from "@solana/kit";
import { loadConfig, resetConfigCache } from "./lib/config.ts";
import { openDb, runMigrations, closeDb, insertPoolEvent } from "./lib/db.ts";
import { log, traceId } from "./lib/logger.ts";
import {
  startMetricsServer,
  stopMetricsServer,
  capturedEvents,
  openPositions as openPositionsGauge,
} from "./lib/metrics.ts";
import { RpcPool } from "./lib/rpc-pool.ts";
import { laserStream } from "./lib/laserstream.ts";
import { detectionBus } from "./lib/detection-bus.ts";
import { SafetyChecker } from "./lib/safety.ts";
import { DecisionEngine } from "./lib/decision.ts";
import { TxEngine } from "./lib/tx-engine.ts";
import { WalletPool } from "./lib/wallet-pool.ts";
import { PriceFeed } from "./lib/price-feed.ts";
import { PositionManager } from "./lib/position-manager.ts";
import { RiskGuard } from "./lib/risk-guard.ts";
import { KillSwitch } from "./lib/killswitch.ts";
import { AuditLog } from "./lib/audit.ts";
import { appendJsonl } from "./lib/storage.ts";
import { DEXES } from "./lib/dexes.ts";
import { findMatchedEvent } from "./lib/liquidity.ts";
import { computeLiquidityKit, type KitTxLike } from "./lib/helius-liquidity.ts";
import { makeHelius } from "./lib/helius.ts";
import type { PoolEvent } from "./lib/types.ts";

// ─── Args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const mode = (getFlag("--mode") ?? "shadow") as "shadow" | "live";
const configPath = getFlag("--config");

if (mode !== "shadow" && mode !== "live") {
  console.error("--mode must be 'shadow' or 'live'");
  process.exit(1);
}

// ─── Boot ──────────────────────────────────────────────────────────

resetConfigCache();
const config = loadConfig(configPath);
const db = openDb(config.database.path);
runMigrations(db);

log.info("runtime starting", { mode, configPath: configPath ?? "default" });

// Metrics
if (config.metrics.enabled) {
  startMetricsServer(config.metrics.port);
}

// RPC Pool
const rpcPool = new RpcPool(
  config.rpc.httpUrls,
  config.rpc.commitment as "processed" | "confirmed" | "finalized",
  config.rpc.maxSlotLag,
);
const connection = rpcPool.getConnection();

// Wallet Pool
const walletPool = new WalletPool(config.wallet.keypairPaths, config.wallet.minBalanceSol);
log.info("wallet pool initialized", { size: walletPool.size() });

// Safety Checker
const safetyChecker = new SafetyChecker(connection, config);

// Decision Engine
const decisionEngine = new DecisionEngine(config);

// Tx Engine
const txEngine = new TxEngine(config);

// Position Manager
const positionManager = new PositionManager(config);
positionManager.loadFromDb();
openPositionsGauge.set(positionManager.positions.size);

// Price Feed
const priceFeed = new PriceFeed(connection);

// Risk Guard
const riskGuard = new RiskGuard(config.risk);

// Kill Switch
const killSwitch = new KillSwitch(
  config.killswitch.hmacSecret ?? undefined,
  config.killswitch.haltFilePath,
);
killSwitch.startFileWatcher();
killSwitch.startHttpEndpoint(config.metrics.port + 1); // 9091

// Audit
const audit = new AuditLog(config);

log.info("all services initialized", { mode });

// ─── Watchdog ──────────────────────────────────────────────────────

const crashCounts: Map<string, { count: number; firstAt: number }> = new Map();
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 5 * 60 * 1000;

function recordCrash(service: string): boolean {
  const now = Date.now();
  const entry = crashCounts.get(service) ?? { count: 0, firstAt: now };
  if (now - entry.firstAt > CRASH_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count++;
  crashCounts.set(service, entry);

  if (entry.count >= MAX_CRASHES) {
    log.fatal("watchdog: too many crashes, tripping kill-switch", { service, count: entry.count });
    killSwitch.halt(`watchdog: ${service} crashed ${entry.count} times`);
    return true;
  }
  return false;
}

// ─── WS event stream (from Helius) ────────────────────────────────

async function* wsEventStream(signal: AbortSignal): AsyncGenerator<PoolEvent> {
  const helius = makeHelius();
  const seenSigs = new Set<string>();

  // Throttle getTransaction to avoid 429s on free-tier Helius (10 req/s)
  const TX_FETCH_MAX = 3;
  let txFetchInflight = 0;
  const txFetchQueue: Array<() => void> = [];
  const acquireTxSlot = (): Promise<void> => {
    if (txFetchInflight < TX_FETCH_MAX) {
      txFetchInflight++;
      return Promise.resolve();
    }
    return new Promise<void>((r) =>
      txFetchQueue.push(() => {
        txFetchInflight++;
        r();
      }),
    );
  };
  const releaseTxSlot = (): void => {
    txFetchInflight--;
    const next = txFetchQueue.shift();
    if (next) next();
  };

  // Simplified: use existing capture-helius logic pattern
  const queue: PoolEvent[] = [];
  let resolve: (() => void) | null = null;

  const runDex = async (dex: (typeof DEXES)[number]) => {
    let reconnects = 0;
    while (!signal.aborted) {
      try {
        const req = await helius.ws.logsNotifications(
          { mentions: [address(dex.programId)] },
          { commitment: "confirmed" },
        );
        const stream = await req.subscribe({ abortSignal: signal });
        reconnects = 0;
        for await (const notif of stream) {
          const parsed = extractLog(notif);
          if (!parsed) continue;
          if (parsed.value.err) continue;

          const matched = findMatchedEvent(parsed.value.logs as string[], dex.events);
          if (!matched) continue;
          if (seenSigs.has(parsed.value.signature)) continue;
          seenSigs.add(parsed.value.signature);
          if (seenSigs.size > 5000) {
            const iter = seenSigs.values();
            for (let i = 0; i < 1000; i++) seenSigs.delete(iter.next().value as string);
          }

          // Fetch full tx (throttled)
          let tx: KitTxLike | null = null;
          await acquireTxSlot();
          try {
            for (let attempt = 0; attempt < 3 && !tx; attempt++) {
              try {
                tx = (await helius.raw.getTransaction(
                  parsed.value.signature as Signature,
                  {
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed",
                  } as Parameters<typeof helius.raw.getTransaction>[1],
                )) as unknown as KitTxLike | null;
              } catch {
                // retry with exponential backoff
              }
              if (!tx) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          } finally {
            releaseTxSlot();
          }
          if (!tx) continue;

          const liq = computeLiquidityKit(tx, dex.programId);
          if (liq.sol < 0.01) continue;

          const blockTime = tx.blockTime == null ? null : Number(tx.blockTime);
          const ev: PoolEvent = {
            capturedAt: new Date().toISOString(),
            slot: parsed.slot,
            blockTime,
            dexKey: dex.key,
            programId: dex.programId,
            eventType: matched.rule.type,
            matchedSignature: matched.match,
            txSignature: parsed.value.signature,
            solValue: liq.sol,
            tokens: liq.tokens,
            signer: liq.signer,
            programAccounts: liq.programAccounts,
            detectedAt: Date.now(),
            detectedBy: "ws",
          };

          queue.push(ev);
          if (resolve) {
            resolve();
            resolve = null;
          }
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError" || signal.aborted) return;
        reconnects++;
        log.warn("ws stream reconnecting", { dex: dex.key, reconnects, error: err.message });
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * reconnects)));
      }
    }
  };

  // Start all DEX streams
  for (const dex of DEXES) {
    runDex(dex).catch((e) => {
      log.error("ws dex stream fatal", { dex: dex.key, error: String(e) });
    });
  }

  // Yield events from queue
  while (!signal.aborted) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await new Promise<void>((r) => {
        resolve = r;
        setTimeout(r, 1000); // poll fallback
      });
    }
  }
}

interface LogValue {
  signature: string;
  logs: readonly string[];
  err: unknown;
}
function extractLog(notif: unknown): { value: LogValue; slot: number } | null {
  if (!notif || typeof notif !== "object") return null;
  const top = notif as { value?: unknown; context?: { slot?: number | bigint } };
  const v = top.value ?? notif;
  if (!v || typeof v !== "object") return null;
  const value = v as Partial<LogValue>;
  if (typeof value.signature !== "string" || !Array.isArray(value.logs)) return null;
  const slot = top.context?.slot;
  return {
    value: {
      signature: value.signature,
      logs: value.logs as readonly string[],
      err: value.err ?? null,
    },
    slot: typeof slot === "bigint" ? Number(slot) : (slot ?? 0),
  };
}

// ─── Main pipeline ─────────────────────────────────────────────────

const controller = new AbortController();

async function mainLoop() {
  const wsEvents = wsEventStream(controller.signal);

  // Set up gRPC stream if configured
  let grpcEvents: AsyncIterable<PoolEvent> | undefined;
  if (config.rpc.grpcUrl) {
    grpcEvents = laserStream({
      grpcUrl: config.rpc.grpcUrl,
      grpcToken: config.rpc.grpcToken,
      programIds: DEXES.map((d) => d.programId),
      signal: controller.signal,
    });
  }

  const bus = detectionBus({ wsEvents, grpcEvents });

  // Pre-compute the lowest minSol across all enabled strategies.
  // Pools below this can't fire ANY strategy, so skip expensive safety.
  const lowestMinSol = config.strategies.reduce(
    (min, s) => (s.enabled && s.minSol < min ? s.minSol : min),
    Infinity,
  );

  for await (const event of bus) {
    if (controller.signal.aborted) break;
    if (killSwitch.isHalted()) continue;

    const tid = traceId();

    try {
      // 1. Persist raw event
      appendJsonl("data/pools.jsonl", event);
      insertPoolEvent(db, {
        signature: event.txSignature,
        slot: event.slot,
        dexKey: event.dexKey,
        eventType: event.eventType,
        solValue: event.solValue,
        capturedAt: event.capturedAt,
        tokens: event.tokens,
        signer: event.signer,
      });
      capturedEvents.inc();
      audit.logDetection(tid, event);

      // 2. Pre-filter: skip expensive safety for pools below ALL strategies' minSol.
      //    The per-strategy E2 size gate already rejects these, so safety would be wasted RPC budget.
      let safetyResult: Awaited<ReturnType<typeof safetyChecker.evaluate>>;
      if (event.solValue < lowestMinSol) {
        safetyResult = {
          pass: false,
          checks: [
            {
              name: "pre-filter",
              pass: false,
              reason: `${event.solValue.toFixed(2)} SOL < ${lowestMinSol} global min`,
              durationMs: 0,
            },
          ],
          totalDurationMs: 0,
          enrichment: null,
        };
      } else {
        safetyResult = await safetyChecker.evaluate(event);
      }
      audit.logSafetyCheck(tid, safetyResult);

      // 3. Decision
      const decisions = decisionEngine.evaluate(
        event,
        safetyResult.enrichment,
        safetyResult,
        positionManager.getOpenCountByStrategy(),
      );

      for (const decision of decisions) {
        audit.logDecision(tid, decision);

        if (!decision.fire || !decision.plan) continue;

        // Log shadow-fire for analysis — captures decisions regardless of wallet/risk availability
        appendJsonl("data/shadow-fires.jsonl", {
          ts: new Date().toISOString(),
          traceId: tid,
          strategyId: decision.strategyId,
          mint: decision.plan.mint,
          dexKey: decision.plan.dexKey,
          pool: decision.plan.pool,
          sizeSol: decision.plan.sizeSol,
          eventType: event.eventType,
          solValue: event.solValue,
          signer: event.signer,
          slot: event.slot,
          safetyPass: safetyResult.pass,
          mode,
        });

        // 4. Risk check
        const riskCheck = riskGuard.preTrade(
          decision.strategyId,
          decision.plan.sizeSol,
          rpcPool.healthy(),
        );
        if (!riskCheck.allowed) {
          log.warn("risk guard blocked trade", {
            strategyId: decision.strategyId,
            reason: riskCheck.reason,
          });
          continue;
        }

        // 5. Execute
        const keypair = await walletPool.getNextKeypair(connection, decision.strategyId);
        if (!keypair) {
          log.warn("no available wallet for trade", { strategyId: decision.strategyId });
          continue;
        }

        const attempt = await txEngine.submit(decision.plan, keypair, connection, mode);
        audit.logTxAttempt(tid, attempt);

        // 6. Post-trade
        const simFailed = attempt.status === "failed";
        riskGuard.postTrade(0, simFailed); // P&L tracked on close

        if (
          attempt.status === "shadow" ||
          attempt.status === "submitted" ||
          attempt.status === "confirmed"
        ) {
          // Open position
          const mint = event.tokens.find(
            (t) => !new Set(["So11111111111111111111111111111111111111112"]).has(t),
          );
          if (mint) {
            const pos = {
              id: decision.plan.attemptId,
              strategyId: decision.strategyId,
              mint,
              pool: event.txSignature,
              state: "open" as const,
              openedAt: new Date().toISOString(),
              closedAt: null,
              closeReason: null,
              closeSig: null,
              traceId: tid,
              // Position fields
              poolSignature: event.txSignature,
              dexKey: event.dexKey,
              entrySlot: event.slot,
              entryAt: new Date().toISOString(),
              entryPrice: 0, // filled on first price snap
              baselineQuoteReserve: 0,
              size: decision.plan.sizeSol,
              tokenAmount: 0,
              peakPrice: 0,
              realisedFrac: 0,
              realisedSol: 0,
            };
            positionManager.addPosition(pos);
            openPositionsGauge.set(positionManager.positions.size);

            // Subscribe price feed for this position's pool
            priceFeed.subscribe(mint, event.txSignature, event.dexKey, event.programAccounts);
          }
        }
      }
    } catch (err) {
      log.error("pipeline error", { traceId: tid, error: String(err) });
      if (recordCrash("pipeline")) break;
    }
  }
}

// ─── Price feed → exit loop ────────────────────────────────────────

async function exitLoop() {
  for await (const snap of priceFeed.snapshots()) {
    if (controller.signal.aborted) break;
    if (killSwitch.isHalted()) continue;

    try {
      const exitPlans = positionManager.onPriceSnap(snap);
      for (const plan of exitPlans) {
        const keypair = await walletPool.getNextKeypair(connection);
        if (!keypair) {
          log.warn("no wallet for exit");
          continue;
        }

        const attempt = await txEngine.submit(plan, keypair, connection, mode);
        audit.logTxAttempt(plan.traceId, attempt);

        if (attempt.status !== "failed") {
          positionManager.closePosition(
            plan.positionId!,
            plan.kind === "exit_full" ? "exit" : "partial",
            attempt.sig,
          );
          openPositionsGauge.set(positionManager.positions.size);
        }
      }
    } catch (err) {
      log.error("exit loop error", { error: String(err) });
    }
  }
}

// ─── Signal handlers ───────────────────────────────────────────────

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown requested", { signal });

  controller.abort();

  // Graceful cleanup
  priceFeed.close();
  rpcPool.close();
  killSwitch.close();
  stopMetricsServer();
  closeDb();

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Start ─────────────────────────────────────────────────────────

log.info("runtime started", {
  mode,
  strategies: config.strategies.filter((s) => s.enabled).map((s) => s.id),
  wallets: walletPool.size(),
  rpcProviders: config.rpc.httpUrls.length,
  grpc: Boolean(config.rpc.grpcUrl),
});

// Run main pipeline and exit loop concurrently
void Promise.all([
  mainLoop().catch((e) => {
    log.fatal("main loop crashed", { error: String(e) });
    if (!recordCrash("mainLoop")) {
      // Restart after backoff
      setTimeout(() => {
        mainLoop().catch(() => shutdown("crash"));
      }, 5000);
    }
  }),
  exitLoop().catch((e) => {
    log.fatal("exit loop crashed", { error: String(e) });
    if (!recordCrash("exitLoop")) {
      setTimeout(() => {
        exitLoop().catch(() => shutdown("crash"));
      }, 5000);
    }
  }),
]);
