/**
 * Yellowstone gRPC stream → PoolEvent async generator.
 *
 * Wraps @triton-one/yellowstone-grpc defensively. On connection failure
 * or missing dependency, degrades gracefully (yields nothing).
 */

import type { PoolEvent } from "./types.ts";
import type { EventType } from "./dexes.ts";
import { DEX_BY_PROGRAM } from "./dexes.ts";
import { findMatchedEvent } from "./liquidity.ts";
import { log } from "./logger.ts";

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

const logger = log.child({ component: "laserstream" });

export async function* laserStream(opts: {
  grpcUrl: string;
  grpcToken?: string;
  programIds: string[];
  signal: AbortSignal;
}): AsyncGenerator<PoolEvent> {
  const { grpcUrl, grpcToken, programIds, signal } = opts;

  if (!grpcUrl) {
    logger.warn("gRPC URL not configured — gRPC detection disabled");
    return;
  }

  // Dynamic import to handle missing/broken dependency gracefully
  let Client: any;
  try {
    const mod: any = await import("@triton-one/yellowstone-grpc");
    Client = mod.default ?? mod;
  } catch (err) {
    logger.warn("Failed to load @triton-one/yellowstone-grpc, gRPC disabled", {
      error: String(err),
    });
    return;
  }

  // Build program filter set for fast lookup
  const programSet = new Set(programIds);

  let backoff = INITIAL_BACKOFF_MS;

  while (!signal.aborted) {
    try {
      const client = new Client(grpcUrl, grpcToken ?? undefined, undefined);
      const stream = await client.subscribe();

      // Build subscribe request: filter transactions by program IDs
      const txFilters: Record<string, unknown> = {};
      for (const pid of programIds) {
        txFilters[pid] = {
          vote: false,
          failed: false,
          accountInclude: [pid],
          accountExclude: [],
          accountRequired: [],
        };
      }

      const request = {
        accounts: {},
        slots: {},
        transactions: txFilters,
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: 0, // PROCESSED
        accountsDataSlice: [],
        ping: undefined,
      };

      await new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        stream.write(request, (err: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Reset backoff on successful connection
      backoff = INITIAL_BACKOFF_MS;
      logger.info("gRPC stream connected", { url: grpcUrl, programs: programIds.length });

      for await (const msg of stream) {
        if (signal.aborted) break;

        const tx = msg?.transaction;
        if (!tx?.transaction?.meta?.logMessages) continue;

        const meta = tx.transaction.meta;
        const logs: string[] = meta.logMessages;
        const slot: number = Number(tx.slot ?? 0);
        const sig: string = tx.transaction.signature
          ? typeof tx.transaction.signature === "string"
            ? tx.transaction.signature
            : Buffer.from(tx.transaction.signature).toString("base64")
          : "";

        // Try to match against known DEX programs
        for (const pid of programIds) {
          if (!programSet.has(pid)) continue;
          const dex = DEX_BY_PROGRAM[pid];
          if (!dex) continue;

          const matched = findMatchedEvent(logs, dex.events);
          if (!matched) continue;

          // Extract accounts from the transaction
          const accountKeys: string[] =
            tx.transaction.transaction?.message?.accountKeys?.map((k: Uint8Array | string) =>
              typeof k === "string" ? k : Buffer.from(k).toString("base64"),
            ) ?? [];

          const signer = accountKeys[0] ?? null;

          // Extract token mints from logs (non-stable mints)
          const tokens: string[] = [];
          const programAccounts: string[] = [];
          for (const key of accountKeys) {
            // Heuristic: accounts in the loaded writable set are program accounts
            if (key !== signer) {
              programAccounts.push(key);
            }
          }

          const event: PoolEvent = {
            capturedAt: new Date().toISOString(),
            slot,
            blockTime: null,
            dexKey: dex.key,
            programId: pid,
            eventType: matched.rule.type as EventType,
            matchedSignature: matched.match,
            txSignature: sig,
            solValue: 0, // Cannot compute full liquidity from gRPC stream data
            tokens,
            signer,
            programAccounts,
            detectedAt: Date.now(),
            detectedBy: "grpc",
          };

          yield event;
          break; // One match per tx
        }
      }

      // Stream ended cleanly
      logger.info("gRPC stream ended");
    } catch (err) {
      if (signal.aborted) return;
      logger.warn("gRPC stream error, reconnecting", {
        error: String(err),
        backoffMs: backoff,
      });
    }

    if (signal.aborted) return;

    // Exponential backoff before reconnect
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoff);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
