/**
 * Liquidity / value-of-tx math, shared by monitor + capture.
 *
 * Estimate the SOL value moved in a transaction:
 *   wsolFlow   = sum of positive WSOL balance deltas across all accounts.
 *                (Total in == total out, so picking one side gives the size
 *                 of the flow without double-counting.)
 *   nativeFlow = sum of positive native-SOL balance deltas (in lamports).
 *
 * We take max(wsolFlow, nativeFlow): in most pool-creation / deposit txes
 * the WSOL and native flows are two sides of the same wrap/unwrap, so
 * summing would double-count.
 */

import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { STABLE_MINTS, WSOL, type EventRule } from "./dexes.ts";

export interface Liquidity {
  sol: number;
  tokens: string[];
  signer: string | null;
  programAccounts: string[];
}

export function computeLiquidity(
  tx: ParsedTransactionWithMeta,
  programId: string,
): Liquidity {
  const preWsol = new Map<number, number>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.mint === WSOL) preWsol.set(b.accountIndex, Number(b.uiTokenAmount.uiAmount ?? 0));
  }
  let wsolFlow = 0;
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.mint !== WSOL) continue;
    const post = Number(b.uiTokenAmount.uiAmount ?? 0);
    const pre = preWsol.get(b.accountIndex) ?? 0;
    const delta = post - pre;
    if (delta > 0) wsolFlow += delta;
  }

  let nativeLamports = 0;
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  for (let i = 0; i < pre.length; i++) {
    const preBal = pre[i] ?? 0;
    const postBal = post[i] ?? 0;
    const delta = postBal - preBal;
    if (delta > 0) nativeLamports += delta;
  }
  const nativeSol = nativeLamports / 1e9;

  const tokenMints = new Set<string>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.mint && !STABLE_MINTS.has(b.mint)) tokenMints.add(b.mint);
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.mint && !STABLE_MINTS.has(b.mint)) tokenMints.add(b.mint);
  }

  // Pull out the unique non-system accounts the program touched. These are
  // good candidates for the pool / vault accounts we later sample reserves
  // from. We dedupe and keep first-seen order so the most "important"
  // accounts (first to appear in the instruction) come first.
  const programAccounts: string[] = [];
  const seenAccount = new Set<string>();
  for (const ix of tx.transaction.message.instructions) {
    if ("programId" in ix && ix.programId.toString() === programId) {
      const accs = "accounts" in ix ? ix.accounts : [];
      for (const a of accs ?? []) {
        const k = a.toString();
        if (!seenAccount.has(k)) {
          seenAccount.add(k);
          programAccounts.push(k);
        }
      }
    }
  }

  const signer = tx.transaction.message.accountKeys[0]?.pubkey.toString() ?? null;
  return {
    sol: Math.max(wsolFlow, nativeSol),
    tokens: [...tokenMints],
    signer,
    programAccounts,
  };
}

export function findMatchedEvent(
  logs: string[],
  events: EventRule[],
): { rule: EventRule; match: string } | null {
  const haystack = logs.join("\n").toLowerCase();
  for (const rule of events) {
    for (const sig of rule.signatures) {
      if (haystack.includes(sig.toLowerCase())) return { rule, match: sig };
    }
  }
  return null;
}
