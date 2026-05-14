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
