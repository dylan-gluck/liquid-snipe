/**
 * Wire / persistence types for the v2 POC pipeline. Every script in
 * scripts/ reads or writes one of these.
 */

import type { EventType } from "./dexes.ts";

/** One LP event the monitor caught — appended to data/pools.jsonl. */
export interface PoolEvent {
  /** ISO-8601 capture wall-clock. Slot is the canonical time. */
  capturedAt: string;
  slot: number;
  blockTime: number | null;
  dexKey: string;
  programId: string;
  eventType: EventType;
  matchedSignature: string;
  txSignature: string;
  /** Sum of positive WSOL/native-SOL inflow on the tx. See lib/liquidity.ts. */
  solValue: number;
  /** Non-stable mints touched by the tx; tokens[0] is usually the pool's base token. */
  tokens: string[];
  /** Tx fee payer — usually the deployer / LP adder. */
  signer: string | null;
  /** Accounts written to by the program, useful for later pool-reserve reads. */
  programAccounts: string[];
  /** Epoch ms when the event was first observed (for latency telemetry). */
  detectedAt?: number;
  /** Source that first saw this event: "ws" | "grpc". */
  detectedBy?: "ws" | "grpc";
}

/** Periodic snapshot of a pool's reserves — data/prices.jsonl. */
export interface PriceSnap {
  takenAt: string;
  slot: number;
  /** Mint we're tracking (the non-stable side). */
  mint: string;
  /** Pool account whose reserves we read. */
  pool: string;
  dexKey: string;
  /** Pool reserves in uiAmount (decimals applied). */
  baseReserve: number;
  quoteReserve: number;
  /** quoteReserve / baseReserve, the indicative spot price in SOL or USD. */
  priceQuotePerBase: number;
  quoteMint: string;
}

/** One-shot enrichment per token — data/enrich/<mint>.json. */
export interface MintEnrichment {
  mint: string;
  fetchedAt: string;
  decimals: number;
  supply: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Top-10 holder concentration as a fraction of supply [0..1]. */
  top10Concentration: number;
  /** True if ≥ 95 % of the *LP* token supply is at a burn / locker address. */
  lpBurnedOrLocked: boolean | null;
  /** Number of prior token mints initialised by the deployer over the last 50 sigs. */
  deployerPriorLaunches: number | null;
  deployer: string | null;
  notes: string[];
}

/** Backtest entry — data/trades.jsonl. */
export interface SimTrade {
  strategyId: string;
  poolSignature: string;
  mint: string;
  dexKey: string;
  entrySlot: number;
  entryAt: string;
  entryPrice: number;
  entrySolSize: number;
  exitSlot: number;
  exitAt: string;
  exitPrice: number;
  exitReason: ExitReason;
  pnlSol: number;
  pnlPct: number;
  /** Peak price seen during the position (for trailing-stop analysis). */
  peakPrice: number;
  durationSec: number;
}

export type ExitReason =
  | "ladder-partial"
  | "ladder-runner"
  | "trail"
  | "time"
  | "stop"
  | "drain"
  | "insider"
  | "decay"
  | "end-of-data";

/** Position state held during the backtest's exit loop. */
export interface Position {
  strategyId: string;
  poolSignature: string;
  mint: string;
  dexKey: string;
  entrySlot: number;
  entryAt: string;
  entryPrice: number;
  baselineQuoteReserve: number;
  /** SOL deployed. */
  size: number;
  /** Tokens received (size / entryPrice, minus simulated slippage). */
  tokenAmount: number;
  /** Mutable: highest price seen so far. */
  peakPrice: number;
  /** Ladder partials already taken, expressed as fraction of original size sold. */
  realisedFrac: number;
  /** Cumulative realised SOL from partials. */
  realisedSol: number;
}

// ─── Live-runtime types (Phase 0+) ────────────────────────────────

/** A decision to enter a trade, routed to TxEngine. */
export interface TradePlan {
  attemptId: string;
  traceId: string;
  strategyId: string;
  mint: string;
  pool: string;
  dexKey: string;
  sizeSol: number;
  maxSlippageBps: number;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  exitConfig: {
    ladderRungs?: Array<{ profit: number; sell: number }>;
    trailPct?: number;
    holdSec?: number;
    stopPct?: number;
    drainPct?: number;
    decayN?: number;
  };
  /** "entry" or "exit_partial" or "exit_full" */
  kind: "entry" | "exit_partial" | "exit_full";
  /** For exits: the position ID being closed. */
  positionId?: string;
  /** Input mint for the swap (WSOL for entries, token mint for exits). */
  inputMint: string;
  /** Output mint for the swap. */
  outputMint: string;
  createdAt: number;
}

/** Result of a transaction attempt. */
export interface TxAttempt {
  id: string;
  positionId: string;
  kind: "entry" | "exit_partial" | "exit_full";
  sig: string | null;
  slot: number | null;
  leader: string | null;
  feeLamports: number;
  cuPrice: number;
  cuUsed: number | null;
  status: "pending" | "shadow" | "simulated" | "submitted" | "confirmed" | "failed" | "reverted";
  error: string | null;
  simLogsJson: string | null;
  createdAt: string;
  traceId: string;
}

/** Safety check result. */
export interface SafetyVerdict {
  pass: boolean;
  checks: Array<{
    name: string;
    pass: boolean;
    reason: string;
    durationMs: number;
  }>;
  totalDurationMs: number;
  enrichment: MintEnrichment | null;
}

/** Risk guard state for the day. */
export interface RiskState {
  date: string;
  pnlSol: number;
  simFailures: number;
  lastReset: string;
}

/** Decision engine output. */
export interface DecisionOutcome {
  fire: boolean;
  strategyId: string;
  plan: TradePlan | null;
  reasons: string[];
  blocked?: string;
}

/** Live position extending the backtest Position with DB fields. */
export interface LivePosition extends Position {
  id: string;
  pool: string;
  state: "open" | "closing" | "closed";
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  closeSig: string | null;
  traceId: string;
}
