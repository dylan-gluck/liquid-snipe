/**
 * Transaction engine — assembles and submits Jupiter swaps via Jito or RPC fallback.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import type { TradePlan, TxAttempt } from "./types.ts";
import type { AppConfig } from "./config.ts";
import { log, traceId as genTraceId } from "./logger.ts";
import { decisionToBroadcastMs } from "./metrics.ts";
import { insertTxAttempt, getDb } from "./db.ts";
import { jupiterQuote, jupiterSwapInstructions } from "./jupiter.ts";
import { submitJitoBundle, randomTipAccount } from "./jito.ts";
import { estimatePriorityFee } from "./priority-fees.ts";

const BLOCKHASH_CACHE_MS = 2_000;

function deserializeInstruction(ix: unknown): TransactionInstruction {
  const obj = ix as {
    programId: string;
    accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: string;
  };
  return new TransactionInstruction({
    programId: new PublicKey(obj.programId),
    keys: obj.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(obj.data, "base64"),
  });
}

function makeTxAttempt(plan: TradePlan, overrides: Partial<TxAttempt>): TxAttempt {
  return {
    id: plan.attemptId,
    positionId: plan.positionId ?? plan.attemptId,
    kind: plan.kind,
    sig: null,
    slot: null,
    leader: null,
    feeLamports: 0,
    cuPrice: 0,
    cuUsed: null,
    status: "failed",
    error: null,
    simLogsJson: null,
    createdAt: new Date().toISOString(),
    traceId: plan.traceId || genTraceId(),
    ...overrides,
  };
}

export class TxEngine {
  private readonly config: AppConfig;
  private readonly logger = log.child({ component: "tx-engine" });
  private cachedBlockhash: { blockhash: string; lastSlot: number; fetchedAt: number } | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async getBlockhash(
    connection: Connection,
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this.cachedBlockhash && now - this.cachedBlockhash.fetchedAt < BLOCKHASH_CACHE_MS) {
      return {
        blockhash: this.cachedBlockhash.blockhash,
        lastValidBlockHeight: this.cachedBlockhash.lastSlot,
      };
    }
    const bh = await connection.getLatestBlockhash("confirmed");
    this.cachedBlockhash = {
      blockhash: bh.blockhash,
      lastSlot: bh.lastValidBlockHeight,
      fetchedAt: now,
    };
    return bh;
  }

  async submit(
    plan: TradePlan,
    keypair: Keypair,
    connection: Connection,
    mode: "shadow" | "live",
  ): Promise<TxAttempt> {
    const t0 = Date.now();

    // 1. Quote
    const jupCfg = this.config.jupiter;
    const amount = Math.round(plan.sizeSol * LAMPORTS_PER_SOL);
    const quote = await jupiterQuote(
      jupCfg.apiUrl,
      plan.inputMint,
      plan.outputMint,
      amount,
      plan.maxSlippageBps,
      jupCfg.maxPriceImpactPct,
    );

    if (!quote) {
      const attempt = makeTxAttempt(plan, {
        status: "failed",
        error: "jupiter quote failed or price impact too high",
      });
      this.persist(attempt);
      return attempt;
    }

    // 2. Swap instructions
    const swapIxs = await jupiterSwapInstructions(
      jupCfg.apiUrl,
      quote,
      keypair.publicKey.toBase58(),
    );
    if (!swapIxs) {
      const attempt = makeTxAttempt(plan, {
        status: "failed",
        error: "jupiter swap-instructions failed",
      });
      this.persist(attempt);
      return attempt;
    }

    // 3. Priority fee
    const feeTier = this.config.jito.enabled ? ("bundle" as const) : ("aggressive" as const);
    const cuPrice =
      plan.priorityFeeMicroLamports > 0
        ? plan.priorityFeeMicroLamports
        : await estimatePriorityFee(connection, [plan.inputMint, plan.outputMint], feeTier);

    // 4. Build instruction set
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ];

    // Setup instructions from Jupiter
    for (const ix of swapIxs.setupInstructions) {
      ixs.push(deserializeInstruction(ix));
    }

    // Main swap
    ixs.push(deserializeInstruction(swapIxs.swapInstruction));

    // Cleanup
    if (swapIxs.cleanupInstruction) {
      ixs.push(deserializeInstruction(swapIxs.cleanupInstruction));
    }

    // Jito tip
    const jitoEnabled = this.config.jito.enabled;
    if (jitoEnabled) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(randomTipAccount()),
          lamports: this.config.jito.tipLamports,
        }),
      );
    }

    // 5. Build versioned transaction
    const { blockhash } = await this.getBlockhash(connection);

    // Resolve address lookup tables
    const lutAccounts: AddressLookupTableAccount[] = [];
    if (swapIxs.addressLookupTableAddresses.length > 0) {
      const lutResults = await Promise.all(
        swapIxs.addressLookupTableAddresses.map((addr) =>
          connection.getAddressLookupTable(new PublicKey(addr)),
        ),
      );
      for (const result of lutResults) {
        if (result.value) lutAccounts.push(result.value);
      }
    }

    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(lutAccounts);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([keypair]);

    // 6. Simulate
    const simResult = await connection.simulateTransaction(tx, { sigVerify: false });
    const simLogs = simResult.value.logs;

    if (simResult.value.err) {
      const attempt = makeTxAttempt(plan, {
        status: "failed",
        cuPrice,
        error: `simulation failed: ${JSON.stringify(simResult.value.err)}`,
        simLogsJson: simLogs ? JSON.stringify(simLogs) : null,
        cuUsed: simResult.value.unitsConsumed ?? null,
      });
      this.persist(attempt);
      return attempt;
    }

    // 7. Shadow mode — don't submit
    if (mode === "shadow") {
      const attempt = makeTxAttempt(plan, {
        status: "shadow",
        cuPrice,
        cuUsed: simResult.value.unitsConsumed ?? null,
        simLogsJson: simLogs ? JSON.stringify(simLogs) : null,
      });
      this.persist(attempt);
      decisionToBroadcastMs.observe(Date.now() - t0);
      return attempt;
    }

    // 8. Live mode — submit
    const serialized = tx.serialize();
    let sig: string | null = null;
    let submitError: string | null = null;

    if (jitoEnabled) {
      const bundleResult = await submitJitoBundle(
        this.config.jito.blockEngineUrl,
        [serialized],
        this.config.jito.tipLamports,
      );
      if (bundleResult.accepted) {
        sig = bundleResult.bundleId;
      } else {
        this.logger.warn("jito bundle failed, falling back to RPC", { error: bundleResult.error });
        submitError = bundleResult.error ?? null;
      }
    }

    // Fallback to direct RPC if Jito disabled or failed
    if (!sig) {
      try {
        sig = await connection.sendRawTransaction(serialized, {
          skipPreflight: true,
          maxRetries: 2,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const attempt = makeTxAttempt(plan, {
          status: "failed",
          cuPrice,
          cuUsed: simResult.value.unitsConsumed ?? null,
          error: submitError ? `jito: ${submitError}; rpc: ${msg}` : msg,
          simLogsJson: simLogs ? JSON.stringify(simLogs) : null,
        });
        this.persist(attempt);
        return attempt;
      }
    }

    const attempt = makeTxAttempt(plan, {
      status: "submitted",
      sig,
      cuPrice,
      cuUsed: simResult.value.unitsConsumed ?? null,
      feeLamports: jitoEnabled ? this.config.jito.tipLamports : 0,
      simLogsJson: simLogs ? JSON.stringify(simLogs) : null,
    });

    decisionToBroadcastMs.observe(Date.now() - t0);
    this.persist(attempt);

    this.logger.info("tx submitted", {
      sig,
      mode,
      kind: plan.kind,
      mint: plan.mint,
      traceId: attempt.traceId,
    });

    return attempt;
  }

  private persist(attempt: TxAttempt): void {
    try {
      const db = getDb();
      insertTxAttempt(db, {
        id: attempt.id,
        positionId: attempt.positionId,
        kind: attempt.kind,
        sig: attempt.sig,
        slot: attempt.slot,
        leader: attempt.leader,
        feeLamports: attempt.feeLamports,
        cuPrice: attempt.cuPrice,
        cuUsed: attempt.cuUsed,
        status: attempt.status,
        error: attempt.error,
        simLogsJson: attempt.simLogsJson,
        createdAt: attempt.createdAt,
        traceId: attempt.traceId,
      });
    } catch (err) {
      // INSERT OR IGNORE for idempotency — if it's a unique constraint error, that's fine
      this.logger.warn("failed to persist tx attempt", {
        id: attempt.id,
        error: String(err),
      });
    }
  }
}
