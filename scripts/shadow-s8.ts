#!/usr/bin/env bun
/**
 * shadow-s8.ts — Paper-trading runner for the S8-confirmed-moon strategy.
 *
 * Detects pool events via Helius WS, applies S8 entry filters, waits for
 * momentum confirmation from the PriceFeed, then tracks virtual positions
 * to their exit (TP / timeout). No wallet, no RPC writes, no real trades.
 *
 * All events are logged to JSONL for later backtest and analysis:
 *   data/s8-shadow/events.jsonl   — every pool event that passes S8 entry
 *   data/s8-shadow/entries.jsonl  — confirmed entries with price
 *   data/s8-shadow/exits.jsonl    — position exits with full P&L
 *   data/s8-shadow/pending.jsonl  — pending confirmation state (append, for debug)
 *   data/pools.jsonl              — raw pool events (shared with other scripts)
 *   data/prices.jsonl             — price snaps (shared with other scripts)
 *
 * Usage:
 *   bun scripts/shadow-s8.ts                     # default 5s poll
 *   bun scripts/shadow-s8.ts --poll-ms 3000      # faster poll
 *   bun scripts/shadow-s8.ts --max-pending 50    # cap pending confirmations
 */

import { address, type Signature } from "@solana/kit";
import { Connection } from "@solana/web3.js";
import { DEXES, STABLE_MINTS, WSOL } from "./lib/dexes.ts";
import { makeHelius, loadApiKey } from "./lib/helius.ts";
import { computeLiquidityKit, type KitTxLike } from "./lib/helius-liquidity.ts";
import { PriceFeed } from "./lib/price-feed.ts";
import { STRATEGY_BY_ID, evaluateEntry, evaluateExit } from "./lib/signals.ts";
import { appendJsonl } from "./lib/storage.ts";
import { log } from "./lib/logger.ts";
import type { PoolEvent, PriceSnap, Position, ExitReason } from "./lib/types.ts";

// ─── Config ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function getFlag(name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

const POLL_MS = Number(getFlag("--poll-ms") ?? 5000);
const MAX_PENDING = Number(getFlag("--max-pending") ?? 100);

const S8 = STRATEGY_BY_ID["S8-confirmed-moon"]!;
const ALLOWED_DEXES = new Set(S8.entry.allowedDexes ?? []);
const CONFIRM_SNAPS = S8.confirmationSnaps ?? 3;
const CONFIRM_PCT = S8.confirmationPct ?? 0.01;
const EXIT_CFG = S8.exit;
const HOLD_SEC = EXIT_CFG.holdSec ?? 600;
const GAS_PER_SIDE = 0.0005;

const EVENTS_PATH = "data/s8-shadow/events.jsonl";
const ENTRIES_PATH = "data/s8-shadow/entries.jsonl";
const EXITS_PATH = "data/s8-shadow/exits.jsonl";
const PENDING_PATH = "data/s8-shadow/pending.jsonl";
const POOLS_PATH = "data/pools.jsonl";

const slog = log.child({ component: "shadow-s8" });

// ─── State ───────────────────────────────────────────────────────────

/** A mint awaiting momentum confirmation before entry. */
interface PendingConfirmation {
  mint: string;
  pool: PoolEvent;
  basePrice: number;
  /** Wall-clock ms when detection happened. */
  detectedAt: number;
  /** Number of price snaps seen since detection. */
  snapsSeen: number;
  /** Price at each snap (for logging). */
  snapPrices: number[];
}

/** A virtual open position being tracked. */
interface ShadowPosition {
  pos: Position;
  exitCfg: typeof EXIT_CFG;
  prevSnaps: PriceSnap[];
  /** Cumulative paper P&L fields. */
  partials: Array<{ at: string; price: number; fraction: number; reason: ExitReason }>;
}

const pendingByMint = new Map<string, PendingConfirmation>();
const positionsByMint = new Map<string, ShadowPosition>();
const enteredMints = new Set<string>();

// ─── Aggregate P&L tracker ──────────────────────────────────────────

let totalPnlSol = 0;
let totalTrades = 0;
let totalWins = 0;

function logSummary(): void {
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0.0";
  slog.info("P&L summary", {
    trades: totalTrades,
    wins: totalWins,
    winRate: `${winRate}%`,
    pnlSol: `${totalPnlSol >= 0 ? "+" : ""}${totalPnlSol.toFixed(5)}`,
    openPositions: positionsByMint.size,
    pendingConfirm: pendingByMint.size,
  });
}

// ─── Entry evaluation ────────────────────────────────────────────────

function evaluateS8Entry(event: PoolEvent): boolean {
  // Quick pre-filters before full evaluation
  if (!ALLOWED_DEXES.has(event.dexKey)) return false;
  if (event.solValue < S8.entry.minSol) return false;

  const result = evaluateEntry({ pool: event, enrichment: null, blocklist: new Set() }, S8.entry);
  return result.ok;
}

// ─── WS pool event stream ────────────────────────────────────────────

async function* poolEventStream(signal: AbortSignal): AsyncGenerator<PoolEvent> {
  const helius = makeHelius();
  const seenSigs = new Set<string>();

  // Throttle getTransaction
  let inflight = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (inflight < 3) {
      inflight++;
      return Promise.resolve();
    }
    return new Promise<void>((r) =>
      queue.push(() => {
        inflight++;
        r();
      }),
    );
  };
  const release = (): void => {
    inflight--;
    const next = queue.shift();
    if (next) next();
  };

  const eventQueue: PoolEvent[] = [];
  let waiter: (() => void) | null = null;

  interface LogValue {
    signature: string;
    err: unknown;
    logs: unknown[];
  }

  function extractLog(notif: unknown): { value: LogValue; slot: number } | null {
    const n = notif as Record<string, unknown> | undefined;
    if (!n) return null;
    const r = n.result as Record<string, unknown> | undefined;
    if (!r) return null;
    const ctx = r.context as { slot: number } | undefined;
    const val = r.value as LogValue | undefined;
    if (!ctx || !val || !val.signature) return null;
    return { value: val, slot: ctx.slot };
  }

  function findMatchedEvent(
    logs: string[],
    rules: Array<{ type: string; signatures: string[] }>,
  ): { rule: (typeof rules)[number]; match: string } | null {
    for (const rule of rules) {
      for (const sig of rule.signatures) {
        if (logs.some((l) => l.includes(sig))) {
          return { rule, match: sig };
        }
      }
    }
    return null;
  }

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

          await acquire();
          let tx: KitTxLike | null = null;
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
                /* retry */
              }
              if (!tx) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          } finally {
            release();
          }
          if (!tx) continue;

          const liq = computeLiquidityKit(tx, dex.programId);
          if (liq.sol < 0.01) continue;

          const ev: PoolEvent = {
            capturedAt: new Date().toISOString(),
            slot: parsed.slot,
            blockTime: tx.blockTime == null ? null : Number(tx.blockTime),
            dexKey: dex.key,
            programId: dex.programId,
            eventType: matched.rule.type as PoolEvent["eventType"],
            matchedSignature: matched.match,
            txSignature: parsed.value.signature,
            solValue: liq.sol,
            tokens: liq.tokens,
            signer: liq.signer,
            programAccounts: liq.programAccounts,
            detectedAt: Date.now(),
            detectedBy: "ws",
          };

          eventQueue.push(ev);
          if (waiter) {
            waiter();
            waiter = null;
          }
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError" || signal.aborted) return;
        reconnects++;
        slog.warn("ws reconnecting", { dex: dex.key, reconnects, error: err.message });
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * reconnects)));
      }
    }
  };

  for (const dex of DEXES) {
    runDex(dex).catch((e) => slog.error("ws dex fatal", { dex: dex.key, error: String(e) }));
  }

  while (!signal.aborted) {
    if (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    } else {
      await new Promise<void>((r) => {
        waiter = r;
        setTimeout(r, 1000);
      });
    }
  }
}

// ─── Price snap handler ──────────────────────────────────────────────

function onPriceSnap(snap: PriceSnap): void {
  // 1. Check pending confirmations
  const pending = pendingByMint.get(snap.mint);
  if (pending) {
    pending.snapsSeen++;
    pending.snapPrices.push(snap.priceQuotePerBase);

    if (snap.priceQuotePerBase <= 0) {
      // Dead snap — skip but count
      if (pending.snapsSeen >= CONFIRM_SNAPS) {
        // Confirmation window expired, no movement
        slog.info("confirmation expired (no price)", { mint: snap.mint.slice(0, 8) });
        appendJsonl(PENDING_PATH, {
          ts: new Date().toISOString(),
          mint: snap.mint,
          outcome: "expired_no_price",
          snapsSeen: pending.snapsSeen,
        });
        pendingByMint.delete(snap.mint);
      }
      return;
    }

    // WSOL quote check
    if (snap.quoteMint !== WSOL) {
      slog.info("rejected: not WSOL quote", {
        mint: snap.mint.slice(0, 8),
        quoteMint: snap.quoteMint,
      });
      appendJsonl(PENDING_PATH, {
        ts: new Date().toISOString(),
        mint: snap.mint,
        outcome: "rejected_not_wsol",
        quoteMint: snap.quoteMint,
      });
      pendingByMint.delete(snap.mint);
      return;
    }

    // Set base price on first valid snap
    if (pending.basePrice <= 0) {
      pending.basePrice = snap.priceQuotePerBase;
      return; // Need at least one more snap to compare
    }

    // Check upward momentum
    const change = snap.priceQuotePerBase / pending.basePrice - 1;
    if (change >= CONFIRM_PCT) {
      // CONFIRMED — open position
      slog.info("entry CONFIRMED", {
        mint: snap.mint.slice(0, 8),
        change: `${(change * 100).toFixed(1)}%`,
        snaps: pending.snapsSeen,
        dex: pending.pool.dexKey,
      });
      pendingByMint.delete(snap.mint);
      openPosition(pending, snap);
      return;
    }

    if (pending.snapsSeen >= CONFIRM_SNAPS) {
      // Window expired without sufficient movement
      slog.info("confirmation expired", {
        mint: snap.mint.slice(0, 8),
        maxChange: `${(change * 100).toFixed(2)}%`,
        snaps: pending.snapsSeen,
      });
      appendJsonl(PENDING_PATH, {
        ts: new Date().toISOString(),
        mint: snap.mint,
        outcome: "expired",
        basePrice: pending.basePrice,
        lastPrice: snap.priceQuotePerBase,
        change,
        snapsSeen: pending.snapsSeen,
        snapPrices: pending.snapPrices,
      });
      pendingByMint.delete(snap.mint);
    }
    return;
  }

  // 2. Update open positions
  const shadow = positionsByMint.get(snap.mint);
  if (!shadow) return;

  const pos = shadow.pos;

  // Update peak
  if (snap.priceQuotePerBase > pos.peakPrice) {
    pos.peakPrice = snap.priceQuotePerBase;
  }

  const decision = evaluateExit(pos, snap, shadow.prevSnaps, shadow.exitCfg);
  shadow.prevSnaps.push(snap);
  if (shadow.prevSnaps.length > 32) shadow.prevSnaps.shift();

  if (!decision.exit) return;

  // Apply simulated slippage
  const slippage =
    snap.quoteReserve > 0
      ? Math.min(0.2, (pos.size * decision.sellFraction) / (snap.quoteReserve + 1e-9))
      : 0;
  const fillPrice = decision.price * (1 - slippage);
  const tokensSold = pos.tokenAmount * decision.sellFraction;
  const proceeds = tokensSold * fillPrice - GAS_PER_SIDE;
  pos.realisedSol += proceeds;
  pos.realisedFrac += decision.sellFraction;
  pos.tokenAmount -= tokensSold;

  shadow.partials.push({
    at: snap.takenAt,
    price: fillPrice,
    fraction: decision.sellFraction,
    reason: decision.reason,
  });

  if (pos.realisedFrac >= 1 - 1e-9) {
    // Position fully closed
    const pnlSol = pos.realisedSol - pos.size;
    const pnlPct = pos.size > 0 ? pnlSol / pos.size : 0;
    const elapsed = (Date.parse(snap.takenAt) - Date.parse(pos.entryAt)) / 1000;

    totalTrades++;
    totalPnlSol += pnlSol;
    if (pnlSol > 0) totalWins++;

    const exitLog = {
      ts: new Date().toISOString(),
      mint: pos.mint,
      dex: pos.dexKey,
      strategyId: pos.strategyId,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      peakPrice: pos.peakPrice,
      peakPct: pos.entryPrice > 0 ? (pos.peakPrice / pos.entryPrice - 1) * 100 : 0,
      pnlSol,
      pnlPct,
      size: pos.size,
      reason: decision.reason,
      durationSec: elapsed,
      partials: shadow.partials,
      runTotalPnl: totalPnlSol,
      runTotalTrades: totalTrades,
      runWinRate: totalTrades > 0 ? totalWins / totalTrades : 0,
    };

    appendJsonl(EXITS_PATH, exitLog);
    positionsByMint.delete(snap.mint);

    const tag = pnlSol >= 0 ? "WIN" : "LOSS";
    slog.info(`EXIT ${tag}`, {
      mint: pos.mint.slice(0, 8),
      reason: decision.reason,
      pnl: `${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL (${(pnlPct * 100).toFixed(1)}%)`,
      duration: `${(elapsed / 60).toFixed(1)}m`,
      totalPnl: `${totalPnlSol >= 0 ? "+" : ""}${totalPnlSol.toFixed(5)} SOL`,
      record: `${totalWins}W/${totalTrades - totalWins}L`,
    });
  }
}

// ─── Position opening ────────────────────────────────────────────────

function openPosition(pending: PendingConfirmation, snap: PriceSnap): void {
  const qr = snap.quoteReserve;
  let size = S8.sizeSol(pending.pool);
  // Cap at 0.5% of reserves
  if (qr > 0) {
    size = Math.min(size, Math.max(0.02, qr * 0.005));
  }

  // Entry slippage
  const slippage = qr > 0 ? Math.min(0.2, size / (qr + 1e-9)) : 0;
  const effectiveEntry = snap.priceQuotePerBase * (1 + slippage);
  const tokens = (size - GAS_PER_SIDE) / effectiveEntry;

  if (!Number.isFinite(tokens) || tokens <= 0) {
    slog.warn("position rejected: bad token amount", {
      mint: snap.mint.slice(0, 8),
      size,
      effectiveEntry,
    });
    return;
  }

  const pos: Position = {
    strategyId: "S8-confirmed-moon",
    poolSignature: pending.pool.txSignature,
    mint: snap.mint,
    dexKey: pending.pool.dexKey,
    entrySlot: snap.slot,
    entryAt: snap.takenAt,
    entryPrice: effectiveEntry,
    baselineQuoteReserve: qr,
    size,
    tokenAmount: tokens,
    peakPrice: effectiveEntry,
    realisedFrac: 0,
    realisedSol: 0,
  };

  positionsByMint.set(snap.mint, {
    pos,
    exitCfg: EXIT_CFG,
    prevSnaps: [snap],
    partials: [],
  });
  enteredMints.add(snap.mint);

  const entryLog = {
    ts: new Date().toISOString(),
    mint: snap.mint,
    dex: pending.pool.dexKey,
    eventType: pending.pool.eventType,
    solValue: pending.pool.solValue,
    signer: pending.pool.signer,
    entryPrice: effectiveEntry,
    rawPrice: snap.priceQuotePerBase,
    slippage,
    size,
    tokens,
    quoteReserve: qr,
    confirmationSnaps: pending.snapsSeen,
    confirmationPrices: pending.snapPrices,
    poolSignature: pending.pool.txSignature,
  };

  appendJsonl(ENTRIES_PATH, entryLog);

  slog.info("ENTRY", {
    mint: snap.mint.slice(0, 8),
    dex: pending.pool.dexKey,
    price: effectiveEntry.toExponential(3),
    size: `${size.toFixed(4)} SOL`,
    reserve: `${qr.toFixed(1)} SOL`,
  });
}

// ─── Main ────────────────────────────────────────────────────────────

const controller = new AbortController();
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  slog.info("shutdown", { signal });
  logSummary();
  controller.abort();
  priceFeed.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Boot ────────────────────────────────────────────────────────────

const apiKey = loadApiKey();
if (!apiKey) {
  slog.error("HELIUS_API_KEY not set");
  process.exit(1);
}

const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const connection = new Connection(rpcUrl, "confirmed");
const priceFeed = new PriceFeed(connection, POLL_MS);

slog.info("shadow-s8 starting", {
  pollMs: POLL_MS,
  maxPending: MAX_PENDING,
  tp: `${(EXIT_CFG.ladderRungs?.[0]?.profit ?? 0) * 100}%`,
  holdSec: HOLD_SEC,
  confirmSnaps: CONFIRM_SNAPS,
  confirmPct: `${CONFIRM_PCT * 100}%`,
});

// Pool event ingestion loop
async function ingestLoop(): Promise<void> {
  for await (const event of poolEventStream(controller.signal)) {
    if (controller.signal.aborted) break;

    // Persist raw event
    appendJsonl(POOLS_PATH, event);

    // S8 entry evaluation
    if (!evaluateS8Entry(event)) continue;

    const mint = event.tokens.find((t) => !STABLE_MINTS.has(t));
    if (!mint) continue;

    // Dedup
    if (enteredMints.has(mint) || pendingByMint.has(mint)) continue;

    // Cap pending queue
    if (pendingByMint.size >= MAX_PENDING) continue;

    // Subscribe price feed for tracking
    if (event.programAccounts.length > 0) {
      priceFeed.subscribe(mint, event.txSignature, event.dexKey, event.programAccounts);
    }

    // Add to pending confirmation
    pendingByMint.set(mint, {
      mint,
      pool: event,
      basePrice: 0, // set on first valid price snap
      detectedAt: Date.now(),
      snapsSeen: 0,
      snapPrices: [],
    });

    appendJsonl(EVENTS_PATH, {
      ts: new Date().toISOString(),
      mint,
      dex: event.dexKey,
      eventType: event.eventType,
      solValue: event.solValue,
      signer: event.signer,
      txSignature: event.txSignature,
    });

    slog.info("pending confirmation", {
      mint: mint.slice(0, 8),
      dex: event.dexKey,
      type: event.eventType,
      sol: event.solValue.toFixed(1),
      pending: pendingByMint.size,
    });
  }
}

// Price snap consumer loop
async function priceLoop(): Promise<void> {
  for await (const snap of priceFeed.snapshots()) {
    if (controller.signal.aborted) break;
    onPriceSnap(snap);
  }
}

// Summary ticker
const summaryInterval = setInterval(() => {
  if (!shuttingDown) logSummary();
}, 60_000);

void Promise.all([
  ingestLoop().catch((e) => {
    slog.error("ingest loop crashed", { error: String(e) });
    shutdown("crash");
  }),
  priceLoop().catch((e) => {
    slog.error("price loop crashed", { error: String(e) });
    shutdown("crash");
  }),
]).finally(() => clearInterval(summaryInterval));
