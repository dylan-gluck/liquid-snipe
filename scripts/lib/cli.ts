/** CLI arg parsing helpers shared by every script entry-point. */

import { Connection, type Commitment } from "@solana/web3.js";

export function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function getInt(argv: string[], flag: string, fallback: number): number {
  const v = getFlag(argv, flag);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getFloat(argv: string[], flag: string, fallback: number): number {
  const v = getFlag(argv, flag);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface RpcArgs {
  rpc: string;
  ws: string;
  commitment: Commitment;
}

export function parseRpcArgs(argv: string[]): RpcArgs {
  const rpc =
    getFlag(argv, "--rpc") ||
    process.env.SOLANA_RPC_HTTP_URL ||
    "https://api.mainnet-beta.solana.com";
  const ws = getFlag(argv, "--ws") || process.env.SOLANA_RPC_WS_URL || rpc.replace(/^http/, "ws");
  const commitment = (getFlag(argv, "--commitment") as Commitment) || "confirmed";
  return { rpc, ws, commitment };
}

export function makeConnection({ rpc, ws, commitment }: RpcArgs): Connection {
  return new Connection(rpc, { commitment, wsEndpoint: ws });
}

/**
 * Silence web3.js's built-in retry chatter — public mainnet-beta spams
 * "Server responded with 429" via console.log / .warn / .error depending
 * on the version. Patch all three. Returns a restore function.
 */
export function silenceRetrySpam(): () => void {
  const isSpam = (a: unknown[]) =>
    typeof a[0] === "string" &&
    (a[0].startsWith("Server responded with 429") || a[0].startsWith("429 Too Many Requests"));
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const method of ["log", "warn", "error"] as const) {
    const orig = originals[method];
    console[method] = ((...a: unknown[]) => {
      if (isSpam(a)) return;
      return (orig as (...args: unknown[]) => void)(...a);
    }) as typeof console.log;
  }
  return () => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  };
}
