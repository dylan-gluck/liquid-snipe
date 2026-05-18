#!/usr/bin/env bun
/**
 * monitor-liquidity.ts
 *
 * Solana mainnet liquidity-event monitor. Subscribes to program logs for major
 * DEX / launchpad programs, then for each matching tx fetches the parsed body
 * and computes the SOL value moved. Events at or above the configured
 * threshold are pretty-printed.
 *
 * Usage:
 *   bun scripts/monitor-liquidity.ts                              # all DEXes, >= 10 SOL
 *   bun scripts/monitor-liquidity.ts --min-sol 25                 # raise threshold
 *   bun scripts/monitor-liquidity.ts --rpc <https> --ws <wss>     # paid RPC
 *   bun scripts/monitor-liquidity.ts --dex raydium-amm,pumpfun    # subset
 *   bun scripts/monitor-liquidity.ts --types INIT,MIGRATE         # filter event types
 *   bun scripts/monitor-liquidity.ts --max-inflight 32            # raise concurrency on paid RPC
 *   bun scripts/monitor-liquidity.ts --raw                        # also dump raw logs (discovery)
 *
 * NOTE: public mainnet-beta RPC drops WebSocket subscriptions under load and
 * rate-limits getParsedTransaction. For real use, point --rpc / --ws at a
 * Helius / QuickNode / Triton endpoint.
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
import { ANSI, EVENT_COLOR, color, shortKey, ts } from "./lib/format.ts";

interface Args {
  rpc: string;
  ws: string;
  commitment: "processed" | "confirmed" | "finalized";
  selected: DexEntry[];
  types: Set<EventType> | null;
  minSol: number;
  maxInflight: number;
  raw: boolean;
  useColor: boolean;
}

function parseArgs(argv: string[]): Args {
  const rpc = parseRpcArgs(argv);
  const minSol = getFloat(argv, "--min-sol", 10);
  const maxInflight = getInt(argv, "--max-inflight", 4);

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
    maxInflight: maxInflight > 0 ? maxInflight : 4,
    raw: hasFlag(argv, "--raw"),
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
        `[${ts()}] connected slot=${slot} rpc=${args.rpc} commitment=${args.commitment}`,
      ),
    );
  } catch (e) {
    console.error(`[${ts()}] failed to connect: ${(e as Error).message}`);
    process.exit(1);
  }

  const typesHint = args.types ? [...args.types].join(",") : "all";
  console.log(
    color(
      args.useColor,
      ANSI.dim,
      `[${ts()}] monitoring ${args.selected.length} programs, min=${args.minSol} SOL, types=${typesHint}, maxInflight=${args.maxInflight}`,
    ),
  );
  for (const d of args.selected) {
    const types = d.events.map((e) => e.type).join("/");
    console.log(
      color(
        args.useColor,
        ANSI.dim,
        `         ${d.name.padEnd(22)} ${shortKey(d.programId)}  [${types}]`,
      ),
    );
  }
  if (args.raw)
    console.log(color(args.useColor, ANSI.dim, `[${ts()}] --raw: ALL logs will be printed`));
  console.log("");

  const stats: Record<string, { seen: number; reported: number; dropped: number; errors: number }> =
    {};
  for (const d of args.selected) stats[d.key] = { seen: 0, reported: 0, dropped: 0, errors: 0 };

  const seenSigs = new Set<string>();
  const MAX_INFLIGHT = args.maxInflight;
  let inflight = 0;

  if (!args.raw) silenceRetrySpam();

  for (const dex of args.selected) {
    const programId = new PublicKey(dex.programId);

    connection.onLogs(
      programId,
      async (logInfo: Logs, ctx) => {
        if (logInfo.err) return;
        const { logs, signature } = logInfo;
        if (!logs || logs.length === 0) return;

        if (args.raw) {
          console.log(
            color(args.useColor, ANSI.dim, `[${ts()}] ${dex.key} ${signature} slot=${ctx.slot}`),
          );
          for (const l of logs) console.log(color(args.useColor, ANSI.dim, `    ${l}`));
        }

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

        if (inflight >= MAX_INFLIGHT) {
          dexStats.dropped++;
          return;
        }
        inflight++;

        let tx: ParsedTransactionWithMeta | null = null;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: args.commitment === "processed" ? "confirmed" : args.commitment,
              });
              if (tx) break;
            } catch {
              if (attempt === 1) dexStats.errors++;
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        } finally {
          inflight--;
        }

        if (!tx) {
          if (args.raw) {
            console.log(
              color(
                args.useColor,
                ANSI.red,
                `[${ts()}] ${dex.key} ${signature} tx not visible yet`,
              ),
            );
          }
          return;
        }

        const { sol, tokens, signer } = computeLiquidity(tx, dex.programId);
        if (sol < args.minSol) return;

        dexStats.reported++;

        const token = tokens[0];
        const time = color(args.useColor, ANSI.dim, `[${ts()}]`);
        const dexLabel = color(args.useColor, ANSI.bold + ANSI.magenta, dex.name.padEnd(18));
        const typeLabel = color(
          args.useColor,
          EVENT_COLOR[matched.rule.type] + ANSI.bold,
          matched.rule.type.padEnd(8),
        );
        const value = color(args.useColor, ANSI.bold, `${sol.toFixed(2).padStart(8)} SOL`);
        const tokStr = token
          ? color(args.useColor, ANSI.white, `tok=${shortKey(token)}`)
          : color(args.useColor, ANSI.dim, "tok=?");
        const signerStr = signer ? color(args.useColor, ANSI.dim, `by=${shortKey(signer)}`) : "";
        const sigStr = color(args.useColor, ANSI.dim, `https://solscan.io/tx/${signature}`);

        console.log(
          `${time}  ${dexLabel} ${typeLabel} ${value}  ${tokStr}  ${signerStr}  ${sigStr}`,
        );
      },
      args.commitment,
    );
  }

  setInterval(() => {
    const parts = Object.entries(stats).map(([k, v]) => {
      const extras = [v.dropped ? `drop=${v.dropped}` : "", v.errors ? `err=${v.errors}` : ""]
        .filter(Boolean)
        .join(",");
      return `${k}=${v.reported}/${v.seen}${extras ? `(${extras})` : ""}`;
    });
    console.log(
      color(args.useColor, ANSI.dim, `[${ts()}] heartbeat reported/seen: ${parts.join(" ")}`),
    );
  }, 60_000);

  const shutdown = (signal: string) => {
    console.log(`\n[${ts()}] received ${signal}, shutting down...`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
