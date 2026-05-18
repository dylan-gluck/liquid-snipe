#!/usr/bin/env bun
/**
 * capture-helius.ts
 *
 * Helius-SDK-based capture: same output schema as capture-pools.ts (writes
 * PoolEvent records to data/pools.jsonl) but uses the Helius
 * `helius.ws.logsNotifications` async-iterator subscription and the
 * `helius.raw.getTransaction` RPC method.
 *
 * Why a separate script: the goal is to validate "Use Helius SDK + RPC +
 * websockets" end-to-end while keeping the original web3.js capture
 * available for users without a Helius API key.
 *
 * Usage:
 *   bun scripts/capture-helius.ts                          # all 8 DEXes, 5 min window
 *   bun scripts/capture-helius.ts --duration 600           # 10 minutes
 *   bun scripts/capture-helius.ts --dex pumpfun,pumpswap
 *   bun scripts/capture-helius.ts --types INIT,MIGRATE
 *   bun scripts/capture-helius.ts --min-sol 1
 *   bun scripts/capture-helius.ts --out data/pools-helius.jsonl
 *   bun scripts/capture-helius.ts --quiet
 */

import { address, type Signature } from "@solana/kit";
import { DEXES, type DexEntry, type EventType } from "./lib/dexes.ts";
import { findMatchedEvent } from "./lib/liquidity.ts";
import { computeLiquidityKit, type KitTxLike } from "./lib/helius-liquidity.ts";
import { getFlag, getFloat, getInt, hasFlag } from "./lib/cli.ts";
import { ANSI, EVENT_COLOR, color, fmtSol, shortKey, ts } from "./lib/format.ts";
import { appendJsonl } from "./lib/storage.ts";
import { loadApiKey, makeHelius } from "./lib/helius.ts";
import type { PoolEvent } from "./lib/types.ts";

interface Args {
  selected: DexEntry[];
  types: Set<EventType> | null;
  minSol: number;
  maxInflight: number;
  durationSec: number;
  out: string;
  quiet: boolean;
  useColor: boolean;
}

function parseArgs(argv: string[]): Args {
  const minSol = getFloat(argv, "--min-sol", 0);
  const maxInflight = getInt(argv, "--max-inflight", 16);
  const out = getFlag(argv, "--out") || "data/pools.jsonl";
  const durationSec = getInt(argv, "--duration", 300);

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
    selected,
    types,
    minSol,
    maxInflight: maxInflight > 0 ? maxInflight : 16,
    durationSec: durationSec > 0 ? durationSec : 300,
    out,
    quiet: hasFlag(argv, "--quiet"),
    useColor: !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY),
  };
}

/** Pull the value payload out of a logsNotifications message — kit emits
 *  the JSON-RPC envelope so the interesting bits are at `.value`. */
interface LogValue {
  signature: string;
  logs: readonly string[];
  err: unknown;
}

function extractLog(notif: unknown): { value: LogValue; slot: number } | null {
  if (!notif || typeof notif !== "object") return null;
  const top = notif as { value?: unknown; context?: { slot?: number | bigint } };
  const v = top.value ?? notif;
  if (!v || typeof v !== "object") return null;
  const value = v as Partial<LogValue>;
  if (typeof value.signature !== "string" || !Array.isArray(value.logs)) return null;
  const slot = top.context?.slot;
  return {
    value: {
      signature: value.signature,
      logs: value.logs as readonly string[],
      err: value.err ?? null,
    },
    slot: typeof slot === "bigint" ? Number(slot) : (slot ?? 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const helius = makeHelius();
  const usingAuth = Boolean(apiKey);

  console.log(
    color(
      args.useColor,
      ANSI.dim,
      `[${ts()}] helius client ready, apiKey=${usingAuth ? "set" : "MISSING"}, duration=${args.durationSec}s → out=${args.out}`,
    ),
  );
  if (!usingAuth) {
    console.error(
      color(
        args.useColor,
        ANSI.yellow,
        `[${ts()}] WARNING: HELIUS_API_KEY not found in env or .env.local. Public Helius endpoint will heavily throttle.`,
      ),
    );
  }

  console.log(
    color(
      args.useColor,
      ANSI.dim,
      `[${ts()}] subscribing to ${args.selected.length} programs, min=${args.minSol} SOL, maxInflight=${args.maxInflight}`,
    ),
  );

  const stats: Record<string, { seen: number; captured: number; dropped: number; errors: number }> =
    {};
  for (const d of args.selected) stats[d.key] = { seen: 0, captured: 0, dropped: 0, errors: 0 };

  const seenSigs = new Set<string>();
  let inflight = 0;
  const controller = new AbortController();

  // Auto-shutdown after duration. Allows scripted, deterministic runs.
  const stopTimer = setTimeout(() => controller.abort(), args.durationSec * 1000);

  const handleNotif = async (dex: DexEntry, raw: unknown): Promise<void> => {
    const parsed = extractLog(raw);
    if (!parsed) return;
    const { value, slot } = parsed;
    if (value.err) return;

    const matched = findMatchedEvent(value.logs as string[], dex.events);
    if (!matched) return;
    if (args.types && !args.types.has(matched.rule.type)) return;
    if (seenSigs.has(value.signature)) return;
    seenSigs.add(value.signature);
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

    try {
      let tx: KitTxLike | null = null;
      for (let attempt = 0; attempt < 3 && !tx; attempt++) {
        try {
          // kit returns the parsed envelope directly thanks to wrapAutoSend.
          const result = (await helius.raw.getTransaction(
            value.signature as Signature,
            {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          )) as unknown as KitTxLike | null;
          if (result) tx = result;
        } catch {
          if (attempt === 2) dexStats.errors++;
        }
        if (!tx) await new Promise((r) => setTimeout(r, 600));
      }
      if (!tx) return;

      const { sol, tokens, signer, programAccounts } = computeLiquidityKit(tx, dex.programId);
      if (sol < args.minSol) return;

      const rawBlockTime = tx.blockTime;
      const blockTime =
        rawBlockTime === undefined || rawBlockTime === null
          ? null
          : typeof rawBlockTime === "bigint"
            ? Number(rawBlockTime)
            : rawBlockTime;
      const rec: PoolEvent = {
        capturedAt: new Date().toISOString(),
        slot,
        blockTime,
        dexKey: dex.key,
        programId: dex.programId,
        eventType: matched.rule.type,
        matchedSignature: matched.match,
        txSignature: value.signature,
        solValue: sol,
        tokens,
        signer,
        programAccounts,
      };
      appendJsonl<PoolEvent>(args.out, rec);
      dexStats.captured++;

      if (!args.quiet) {
        const t = color(args.useColor, ANSI.dim, `[${ts()}]`);
        const dexLabel = color(args.useColor, ANSI.bold + ANSI.magenta, dex.name.padEnd(18));
        const typeLabel = color(
          args.useColor,
          EVENT_COLOR[matched.rule.type] + ANSI.bold,
          matched.rule.type.padEnd(8),
        );
        const value2 = color(args.useColor, ANSI.bold, `${fmtSol(sol)} SOL`);
        const tokStr = tokens[0]
          ? color(args.useColor, ANSI.white, `tok=${shortKey(tokens[0])}`)
          : color(args.useColor, ANSI.dim, "tok=?");
        const signerStr = signer ? color(args.useColor, ANSI.dim, `by=${shortKey(signer)}`) : "";
        const sigStr = color(args.useColor, ANSI.dim, `https://solscan.io/tx/${value.signature}`);
        console.log(`${t}  ${dexLabel} ${typeLabel} ${value2}  ${tokStr}  ${signerStr}  ${sigStr}`);
      }
    } finally {
      inflight--;
    }
  };

  // The kit logsNotifications only supports ONE mention per call, so we
  // open one subscription per DEX program id. Each subscription runs its
  // own loop and auto-reconnects on close — public Helius WS occasionally
  // closes a stream after minutes of idle, so a fresh subscribe keeps the
  // capture alive without restarting the process.
  const runStream = async (dex: DexEntry): Promise<void> => {
    const programAddress = address(dex.programId);
    let reconnects = 0;
    while (!controller.signal.aborted) {
      try {
        const req = await helius.ws.logsNotifications(
          { mentions: [programAddress] },
          { commitment: "confirmed" },
        );
        const stream = await req.subscribe({ abortSignal: controller.signal });
        for await (const notif of stream) {
          handleNotif(dex, notif).catch((e: unknown) => {
            const err = e as Error;
            const dexStats = stats[dex.key]!;
            dexStats.errors++;
            if (!args.quiet) {
              console.error(
                color(args.useColor, ANSI.red, `[${ts()}] ${dex.key} handler: ${err.message}`),
              );
            }
          });
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        reconnects++;
        console.error(
          color(
            args.useColor,
            ANSI.red,
            `[${ts()}] ${dex.key} stream ended (${err.message}); reconnect #${reconnects}`,
          ),
        );
        // Short cool-off so we don't busy-loop if the upstream is broken.
        await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * reconnects)));
      }
    }
  };
  const subscriptions = args.selected.map(runStream);

  const heartbeat = setInterval(() => {
    const parts = Object.entries(stats).map(([k, v]) => {
      const extras = [v.dropped ? `drop=${v.dropped}` : "", v.errors ? `err=${v.errors}` : ""]
        .filter(Boolean)
        .join(",");
      return `${k}=${v.captured}/${v.seen}${extras ? `(${extras})` : ""}`;
    });
    console.log(
      color(args.useColor, ANSI.dim, `[${ts()}] heartbeat captured/seen: ${parts.join(" ")}`),
    );
  }, 30_000);

  const shutdown = (signal: string) => {
    console.log(`\n[${ts()}] received ${signal}, aborting subscriptions...`);
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await Promise.all(subscriptions);
  clearTimeout(stopTimer);
  clearInterval(heartbeat);
  try {
    helius.ws.close();
  } catch {
    /* ignore close errors */
  }

  const total = Object.values(stats).reduce((s, v) => s + v.captured, 0);
  console.log(`[${ts()}] capture complete: ${total} events → ${args.out}`);
}

main().catch((e) => {
  console.error(`[${ts()}] fatal: ${e?.stack || e}`);
  process.exit(1);
});
