#!/usr/bin/env bun
/**
 * snapshot-prices.ts
 *
 * Periodically samples reserves of the AMM pools captured in
 * data/pools.jsonl and appends a PriceSnap per pool per tick to
 * data/prices.jsonl. The price series is the substrate for every exit
 * signal (trail, time, drain, decay) and the backtest's mark-to-market.
 *
 * We deliberately avoid DEX-specific decoders. Instead, for each captured
 * event we look at the program-touched accounts (already in the
 * PoolEvent.programAccounts), call getMultipleParsedAccounts, and find
 *   - one token account owned by the WSOL mint   (quote leg)
 *   - one token account owned by the target mint (base leg)
 * That pair gives us reserves on every AMM that uses split-vault token
 * accounts: Raydium AMM v4, CPMM, Orca legacy, Meteora pools, PumpSwap,
 * pump.fun bonding curves. Whirlpool / Raydium CLMM (concentrated-liq)
 * require fixed-point math from the pool struct — out of scope for POC.
 *
 * Usage:
 *   bun scripts/snapshot-prices.ts                            # tick every 15s, watch newest 30 mints
 *   bun scripts/snapshot-prices.ts --interval 5               # 5-second ticks
 *   bun scripts/snapshot-prices.ts --watch 50                 # watch 50 newest pools
 *   bun scripts/snapshot-prices.ts --hold-sec 1800            # drop a pool from rotation 30 min after capture
 *   bun scripts/snapshot-prices.ts --min-sol 5                # only watch pools opened with ≥ 5 SOL
 *   bun scripts/snapshot-prices.ts --once                     # one snapshot then exit
 */

import { PublicKey } from "@solana/web3.js";
import { WSOL, STABLE_MINTS } from "./lib/dexes.ts";
import { getFlag, getFloat, getInt, hasFlag, makeConnection, parseRpcArgs } from "./lib/cli.ts";
import { ANSI, color, fmtSol, shortKey, ts } from "./lib/format.ts";
import { appendJsonl, readJsonl } from "./lib/storage.ts";
import type { PoolEvent, PriceSnap } from "./lib/types.ts";

interface PoolBinding {
  mint: string;
  pool: PoolEvent;
  /** Resolved token-account addresses (vault accounts) for base + quote legs. */
  baseVault: string | null;
  quoteVault: string | null;
  quoteMint: string;
  /** ISO time we'll stop polling — pool.capturedAt + holdSec. */
  expiresAt: number;
  /** Reserves at first successful read, captured for X5 (drain) baseline. */
  baselineQuoteReserve: number | null;
}

interface ParsedTokenAccount {
  data: {
    parsed: {
      info: {
        mint: string;
        owner: string;
        tokenAmount: {
          amount: string;
          decimals: number;
          uiAmount: number | null;
        };
      };
      type: string;
    };
    program: string;
  };
}

function isParsedTokenAccount(v: unknown): v is ParsedTokenAccount {
  if (!v || typeof v !== "object") return false;
  const data = (v as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return false;
  return (parsed as { type?: string }).type === "account";
}

async function resolveVaults(
  connection: ReturnType<typeof makeConnection>,
  binding: PoolBinding,
): Promise<void> {
  // Look only at the first ~16 program-touched accounts; vault accounts
  // are always among the early ones in pool-init / deposit instructions.
  const candidates = binding.pool.programAccounts.slice(0, 16).map((a) => new PublicKey(a));
  if (candidates.length === 0) return;
  let infos;
  try {
    infos = await connection.getMultipleParsedAccounts(candidates, { commitment: "confirmed" });
  } catch {
    return;
  }
  for (let i = 0; i < infos.value.length; i++) {
    const info = infos.value[i];
    const pk = candidates[i];
    if (!info || !pk) continue;
    if (!("data" in info)) continue;
    if (!isParsedTokenAccount(info)) continue;
    const m = info.data.parsed.info.mint;
    if (m === binding.mint && !binding.baseVault) binding.baseVault = pk.toString();
    else if (STABLE_MINTS.has(m) && !binding.quoteVault) {
      binding.quoteVault = pk.toString();
      binding.quoteMint = m;
    }
  }
}

async function snapPool(
  connection: ReturnType<typeof makeConnection>,
  binding: PoolBinding,
  useColor: boolean,
  outPath: string,
): Promise<void> {
  if (!binding.baseVault || !binding.quoteVault) {
    await resolveVaults(connection, binding);
  }
  if (!binding.baseVault || !binding.quoteVault) return;

  const accounts = [new PublicKey(binding.baseVault), new PublicKey(binding.quoteVault)];
  let infos;
  try {
    infos = await connection.getMultipleParsedAccounts(accounts, { commitment: "confirmed" });
  } catch (e) {
    console.error(color(useColor, ANSI.red, `[${ts()}] snap ${shortKey(binding.mint)}: ${(e as Error).message}`));
    return;
  }

  const base = infos.value[0];
  const quote = infos.value[1];
  if (!base || !quote) return;
  if (!isParsedTokenAccount(base) || !isParsedTokenAccount(quote)) return;

  const baseReserve = base.data.parsed.info.tokenAmount.uiAmount ?? 0;
  const quoteReserve = quote.data.parsed.info.tokenAmount.uiAmount ?? 0;
  const price = baseReserve > 0 ? quoteReserve / baseReserve : 0;

  const slot = await connection.getSlot();
  const rec: PriceSnap = {
    takenAt: new Date().toISOString(),
    slot,
    mint: binding.mint,
    pool: binding.baseVault, // best stable "pool key" we have without dex decoders
    dexKey: binding.pool.dexKey,
    baseReserve,
    quoteReserve,
    priceQuotePerBase: price,
    quoteMint: binding.quoteMint,
  };
  appendJsonl<PriceSnap>(outPath, rec);

  if (binding.baselineQuoteReserve === null && quoteReserve > 0) {
    binding.baselineQuoteReserve = quoteReserve;
  }

  console.log(
    color(useColor, ANSI.dim, `[${ts()}]`) +
      `  ${shortKey(binding.mint).padEnd(11)}  px=${price.toExponential(3)}  ` +
      `base=${baseReserve.toExponential(2)}  quote=${fmtSol(quoteReserve)}  ` +
      `dex=${binding.pool.dexKey}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const inPath = getFlag(argv, "--in") || "data/pools.jsonl";
  const outPath = getFlag(argv, "--out") || "data/prices.jsonl";
  const intervalSec = Math.max(1, getInt(argv, "--interval", 15));
  const watch = Math.max(1, getInt(argv, "--watch", 30));
  const holdSec = Math.max(60, getInt(argv, "--hold-sec", 3600));
  const minSol = getFloat(argv, "--min-sol", 1);
  const once = hasFlag(argv, "--once");
  const useColor = !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY);
  const connection = makeConnection(parseRpcArgs(argv));

  const pools = readJsonl<PoolEvent>(inPath);
  if (pools.length === 0) {
    console.error(`[${ts()}] no records in ${inPath}`);
    process.exit(1);
  }

  // Build the watchlist: newest-first, one entry per mint, ≥ minSol, with
  // a usable signer + programAccounts list.
  const bindings: PoolBinding[] = [];
  const seenMints = new Set<string>();
  for (const p of [...pools].reverse()) {
    if (bindings.length >= watch) break;
    if (p.solValue < minSol) continue;
    if (!p.programAccounts || p.programAccounts.length === 0) continue;
    const mint = p.tokens.find((t) => !STABLE_MINTS.has(t));
    if (!mint || seenMints.has(mint)) continue;
    seenMints.add(mint);
    bindings.push({
      mint,
      pool: p,
      baseVault: null,
      quoteVault: null,
      quoteMint: WSOL,
      // expiresAt is absolute epoch ms; pool.capturedAt + holdSec.
      expiresAt: new Date(p.capturedAt).getTime() + holdSec * 1000,
      baselineQuoteReserve: null,
    });
  }

  console.log(
    color(
      useColor,
      ANSI.dim,
      `[${ts()}] snapshot watching ${bindings.length} pools, interval=${intervalSec}s, hold=${holdSec}s, out=${outPath}`,
    ),
  );
  if (bindings.length === 0) process.exit(0);

  const tick = async () => {
    const now = Date.now();
    const active = bindings.filter((b) => b.expiresAt > now);
    // Parallelism = unlimited per tick; the network of pools we want to
    // watch (≤ 50) is small enough.
    await Promise.all(active.map((b) => snapPool(connection, b, useColor, outPath)));
  };

  await tick();
  if (once) return;
  setInterval(() => {
    tick().catch((e) => console.error(`[${ts()}] tick: ${(e as Error).message}`));
  }, intervalSec * 1000);

  process.on("SIGINT", () => {
    console.log(`\n[${ts()}] stopping snapshot loop`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
