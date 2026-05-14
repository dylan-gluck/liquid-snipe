/**
 * Helius / @solana/kit adapter for the same SOL-flow math as
 * scripts/lib/liquidity.ts. The kit returns Lamports as `bigint` and
 * Addresses as branded strings; we convert to plain numbers / strings so
 * downstream tools work without caring which capture path produced the
 * record.
 */

import { STABLE_MINTS, WSOL } from "./dexes.ts";

/** Loosely-typed kit transaction so we can read fields without pulling in
 *  the full Address/Lamports/Signature branded types — they're string
 *  underneath at runtime. */
export interface KitTxLike {
  meta: {
    preBalances: readonly (bigint | number)[];
    postBalances: readonly (bigint | number)[];
    preTokenBalances?: readonly {
      accountIndex: number;
      mint: string;
      uiTokenAmount: { uiAmount: number | bigint | string | null };
    }[];
    postTokenBalances?: readonly {
      accountIndex: number;
      mint: string;
      uiTokenAmount: { uiAmount: number | bigint | string | null };
    }[];
  } | null;
  transaction: {
    message: {
      accountKeys: readonly ({ pubkey: string } | string)[];
      instructions: readonly (
        | {
            programId: string;
            accounts: readonly string[];
          }
        | { parsed: object; program: string; programId: string }
      )[];
    };
  };
  blockTime?: number | null;
  slot?: number | bigint;
}

export interface Liquidity {
  sol: number;
  tokens: string[];
  signer: string | null;
  programAccounts: string[];
}

function toNumber(x: bigint | number | string | null | undefined): number {
  if (x === null || x === undefined) return 0;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }
  return x;
}

export function computeLiquidityKit(tx: KitTxLike, programId: string): Liquidity {
  const meta = tx.meta;
  let wsolFlow = 0;
  if (meta) {
    const preWsol = new Map<number, number>();
    for (const b of meta.preTokenBalances ?? []) {
      if (String(b.mint) === WSOL) preWsol.set(b.accountIndex, toNumber(b.uiTokenAmount.uiAmount));
    }
    for (const b of meta.postTokenBalances ?? []) {
      if (String(b.mint) !== WSOL) continue;
      const post = toNumber(b.uiTokenAmount.uiAmount);
      const pre = preWsol.get(b.accountIndex) ?? 0;
      const delta = post - pre;
      if (delta > 0) wsolFlow += delta;
    }
  }

  let nativeLamports = 0;
  if (meta) {
    const pre = meta.preBalances;
    const post = meta.postBalances;
    for (let i = 0; i < pre.length; i++) {
      const preBal = toNumber(pre[i] ?? 0);
      const postBal = toNumber(post[i] ?? 0);
      const delta = postBal - preBal;
      if (delta > 0) nativeLamports += delta;
    }
  }
  const nativeSol = nativeLamports / 1e9;

  const tokenMints = new Set<string>();
  if (meta) {
    for (const b of meta.preTokenBalances ?? []) {
      const mint = String(b.mint);
      if (mint && !STABLE_MINTS.has(mint)) tokenMints.add(mint);
    }
    for (const b of meta.postTokenBalances ?? []) {
      const mint = String(b.mint);
      if (mint && !STABLE_MINTS.has(mint)) tokenMints.add(mint);
    }
  }

  // Collect candidate accounts the snapshot script can probe for pool
  // vaults. Two passes:
  //   1) explicit `accounts` on the matching program's instructions (works
  //      for partially-decoded ix where kit didn't have a parser)
  //   2) fallback to all message-level accountKeys when the parser ate the
  //      raw `accounts` list (common for ray_log, pump.fun create/migrate)
  // Snapshot then filters to the token accounts owned by base/quote mint.
  const programAccounts: string[] = [];
  const seen = new Set<string>();
  for (const ix of tx.transaction.message.instructions) {
    if (!("programId" in ix)) continue;
    if (String(ix.programId) !== programId) continue;
    if (!("accounts" in ix)) continue;
    for (const a of ix.accounts ?? []) {
      const k = String(a);
      if (!seen.has(k)) {
        seen.add(k);
        programAccounts.push(k);
      }
    }
  }
  if (programAccounts.length === 0) {
    for (const k of tx.transaction.message.accountKeys) {
      const addr = typeof k === "string" ? k : k.pubkey;
      const s = String(addr);
      if (!seen.has(s)) {
        seen.add(s);
        programAccounts.push(s);
      }
      if (programAccounts.length >= 24) break;
    }
  }

  const firstKey = tx.transaction.message.accountKeys[0];
  const signer =
    firstKey === undefined
      ? null
      : typeof firstKey === "string"
        ? firstKey
        : firstKey.pubkey;
  return {
    sol: Math.max(wsolFlow, nativeSol),
    tokens: [...tokenMints],
    signer: signer ? String(signer) : null,
    programAccounts,
  };
}
