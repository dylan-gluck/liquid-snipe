/**
 * Priority fee estimator — Helius-native with getRecentPrioritizationFees fallback.
 */

import type { Connection } from "@solana/web3.js";
import { log } from "./logger.ts";

const DEFAULTS = { base: 1_000, aggressive: 5_000, bundle: 10_000 } as const;

const logger = log.child({ component: "priority-fees" });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function tryHelius(
  connection: Connection,
  accountKeys: string[],
): Promise<{ p50: number; p75: number; p90: number } | null> {
  // Only attempt if the endpoint looks like Helius
  const url = (connection as unknown as { _rpcEndpoint: string })._rpcEndpoint ?? "";
  if (!url.includes("helius")) return null;

  try {
    const rpcRequest = (
      connection as unknown as {
        _rpcRequest: (method: string, params: unknown[]) => Promise<{ result: unknown }>;
      }
    )._rpcRequest;
    if (typeof rpcRequest !== "function") return null;

    const resp = await rpcRequest.call(connection, "getPriorityFeeEstimate", [
      {
        accountKeys,
        options: { includeAllPriorityFeeLevels: true },
      },
    ]);

    const levels = (resp as { result: { priorityFeeLevels: Record<string, number> } }).result
      ?.priorityFeeLevels;
    if (!levels) return null;

    return {
      p50: levels["medium"] ?? 0,
      p75: levels["high"] ?? 0,
      p90: levels["veryHigh"] ?? 0,
    };
  } catch (err) {
    logger.debug("helius fee estimate failed", { error: String(err) });
    return null;
  }
}

async function tryStandard(
  connection: Connection,
  accountKeys: string[],
): Promise<{ p50: number; p75: number; p90: number } | null> {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const fees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accountKeys.map((k) => new PublicKey(k)),
    });

    if (!fees || fees.length === 0) return null;

    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    };
  } catch (err) {
    logger.debug("standard fee estimate failed", { error: String(err) });
    return null;
  }
}

export async function estimatePriorityFee(
  connection: Connection,
  accountKeys: string[],
  tier: "base" | "aggressive" | "bundle",
): Promise<number> {
  const levels =
    (await tryHelius(connection, accountKeys)) ?? (await tryStandard(connection, accountKeys));

  if (!levels) {
    logger.warn("all fee estimation methods failed, using defaults", { tier });
    return DEFAULTS[tier];
  }

  switch (tier) {
    case "base":
      return levels.p50;
    case "aggressive":
      return levels.p75;
    case "bundle":
      return levels.p90;
  }
}
