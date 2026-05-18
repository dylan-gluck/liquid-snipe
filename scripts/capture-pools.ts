#!/usr/bin/env bun
/**
 * capture-pools.ts
 *
 * Long-running capture loop: same subscriptions as monitor-liquidity.ts, but
 * **persists every matched event** (including small / sub-threshold ones) to
 * data/pools.jsonl for offline analysis, enrichment, and backtesting.
 *
 * Each record is a PoolEvent (see scripts/lib/types.ts). Append-only,
 * append-safe — multiple runs accumulate.
 *
 * Usage:
 *   bun scripts/capture-pools.ts                                  # default ./data/pools.jsonl
 *   bun scripts/capture-pools.ts --out data/pools-2025-05.jsonl   # custom path
 *   bun scripts/capture-pools.ts --min-sol 0                      # capture EVERY matched LP event
 *   bun scripts/capture-pools.ts --rpc <https> --ws <wss>         # paid RPC
 *   bun scripts/capture-pools.ts --dex pumpfun,pumpswap           # subset
 *   bun scripts/capture-pools.ts --types INIT,MIGRATE             # only INITs/MIGRATEs
 *   bun scripts/capture-pools.ts --max-inflight 32                # higher concurrency
 *   bun scripts/capture-pools.ts --quiet                          # don't print per-event
 *
 * The capture is the entry point of the data pipeline. Downstream:
 *   enrich-pools.ts    fills mint authority / holders / deployer history
 *   snapshot-prices.ts samples reserves over time per captured pool
 *   backtest.ts        replays the captures with strategies from research.md
 */

import { PublicKey, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { DEXES, type DexEntry, type EventType } from "./lib/dexes.ts";
import { computeLiquidity, findMatchedEvent } from "./lib/liquidity.ts";
import {
  getFlag,
  getFloat,
  getInt,
  hasFlag,
  makeConnection,
  parseRpcArgs,
  silenceRetrySpam,
} from "./lib/cli.ts";
import { ANSI, EVENT_COLOR, color, fmtSol, shortKey, ts } from "./lib/format.ts";
import { appendJsonl } from "./lib/storage.ts";
import type { PoolEvent } from "./lib/types.ts";

interface Args {
  rpc: string;
  ws: string;
  commitment: "processed" | "confirmed" | "finalized";
  selected: DexEntry[];
  types: Set<EventType> | null;
  minSol: number;
  maxInflight: number;
  out: string;
  quiet: boolean;
  useColor: boolean;
}

function parseArgs(argv: string[]): Args {
  const rpc = parseRpcArgs(argv);
  const minSol = getFloat(argv, "--min-sol", 0);
  const maxInflight = getInt(argv, "--max-inflight", 8);
  const out = getFlag(argv, "--out") || "data/pools.jsonl";

  const dexArg = getFlag(argv, "--dex");
  const selected = dexArg
    ? DEXES.filter((d) =>
        dexArg
          .split(",")
          .map((s) => s.trim())
          .includes(d.key),
      )
    : DEXES;
  if (selected.length === 0) {
    console.error(`No DEX matched --dex=${dexArg}. Known: ${DEXES.map((d) => d.key).join(", ")}`);
    process.exit(1);
  }

  const typesArg = getFlag(argv, "--types");
  const types = typesArg
    ? new Set(typesArg.split(",").map((s) => s.trim().toUpperCase()) as EventType[])
    : null;

  return {
    rpc: rpc.rpc,
    ws: rpc.ws,
    commitment: rpc.commitment as Args["commitment"],
    selected,
    types,
    minSol,
    maxInflight: maxInflight > 0 ? maxInflight : 8,
    out,
    quiet: hasFlag(argv, "--quiet"),
    useColor: !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = makeConnection({ rpc: args.rpc, ws: args.ws, commitment: args.commitment });

  try {
    const slot = await connection.getSlot();
    console.log(
      color(
        args.useColor,
        ANSI.dim,
        `[${ts()}] connected slot=${slot} rpc=${args.rpc} → out=${args.out}`,
      ),
    );
  } catch (e) {
    console.error(`[${ts()}] failed to connect: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(
    color(
      args.useColor,
      ANSI.dim,
      `[${ts()}] capturing ${args.selected.length} programs, min=${args.minSol} SOL, maxInflight=${args.maxInflight}`,
    ),
  );

  const stats: Record<string, { seen: number; captured: number; dropped: number; errors: number }> =
    {};
  for (const d of args.selected) stats[d.key] = { seen: 0, captured: 0, dropped: 0, errors: 0 };

  const seenSigs = new Set<string>();
  let inflight = 0;
  silenceRetrySpam();

  for (const dex of args.selected) {
    const programId = new PublicKey(dex.programId);
    connection.onLogs(
      programId,
      async (logInfo: Logs, ctx) => {
        if (logInfo.err) return;
        const { logs, signature } = logInfo;
        if (!logs || logs.length === 0) return;

        const matched = findMatchedEvent(logs, dex.events);
        if (!matched) return;
        if (args.types && !args.types.has(matched.rule.type)) return;
        if (seenSigs.has(signature)) return;
        seenSigs.add(signature);
        if (seenSigs.size > 5000) {
          const iter = seenSigs.values();
          for (let i = 0; i < 1000; i++) seenSigs.delete(iter.next().value as string);
        }

        const dexStats = stats[dex.key]!;
        dexStats.seen++;

        if (inflight >= args.maxInflight) {
          dexStats.dropped++;
          return;
        }
        inflight++;

        let tx: ParsedTransactionWithMeta | null = null;
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: args.commitment === "processed" ? "confirmed" : args.commitment,
              });
              if (tx) break;
            } catch {
              if (attempt === 2) dexStats.errors++;
            }
            await new Promise((r) => setTimeout(r, 700));
          }
        } finally {
          inflight--;
        }
        if (!tx) return;

        const { sol, tokens, signer, programAccounts } = computeLiquidity(tx, dex.programId);
        if (sol < args.minSol) return;

        const rec: PoolEvent = {
          capturedAt: new Date().toISOString(),
          slot: ctx.slot,
          blockTime: tx.blockTime ?? null,
          dexKey: dex.key,
          programId: dex.programId,
          eventType: matched.rule.type,
          matchedSignature: matched.match,
          txSignature: signature,
          solValue: sol,
          tokens,
          signer,
          programAccounts,
        };
        appendJsonl<PoolEvent>(args.out, rec);
        dexStats.captured++;

        if (!args.quiet) {
          const time = color(args.useColor, ANSI.dim, `[${ts()}]`);
          const dexLabel = color(args.useColor, ANSI.bold + ANSI.magenta, dex.name.padEnd(18));
          const typeLabel = color(
            args.useColor,
            EVENT_COLOR[matched.rule.type] + ANSI.bold,
            matched.rule.type.padEnd(8),
          );
          const value = color(args.useColor, ANSI.bold, `${fmtSol(sol)} SOL`);
          const tokStr = tokens[0]
            ? color(args.useColor, ANSI.white, `tok=${shortKey(tokens[0])}`)
            : color(args.useColor, ANSI.dim, "tok=?");
          const signerStr = signer ? color(args.useColor, ANSI.dim, `by=${shortKey(signer)}`) : "";
          const sigStr = color(args.useColor, ANSI.dim, `sig=${shortKey(signature)}`);
          console.log(
            `${time}  ${dexLabel} ${typeLabel} ${value}  ${tokStr}  ${signerStr}  ${sigStr}`,
          );
        }
      },
      args.commitment,
    );
  }

  setInterval(() => {
    const parts = Object.entries(stats).map(([k, v]) => {
      const extras = [v.dropped ? `drop=${v.dropped}` : "", v.errors ? `err=${v.errors}` : ""]
        .filter(Boolean)
        .join(",");
      return `${k}=${v.captured}/${v.seen}${extras ? `(${extras})` : ""}`;
    });
    console.log(
      color(args.useColor, ANSI.dim, `[${ts()}] heartbeat captured/seen: ${parts.join(" ")}`),
    );
  }, 60_000);

  const shutdown = (signal: string) => {
    const totalCaptured = Object.values(stats).reduce((s, v) => s + v.captured, 0);
    console.log(`\n[${ts()}] received ${signal}, captured ${totalCaptured} events to ${args.out}`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
