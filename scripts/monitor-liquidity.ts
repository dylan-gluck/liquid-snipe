#!/usr/bin/env ts-node
/**
 * monitor-liquidity.ts
 *
 * Solana mainnet liquidity-event monitor. Subscribes to program logs for major
 * DEX / launchpad programs, then for each matching tx fetches the parsed body
 * and computes the SOL value moved. Events at or above the configured
 * threshold are pretty-printed.
 *
 * Usage:
 *   ts-node scripts/monitor-liquidity.ts                              # all DEXes, >= 10 SOL
 *   ts-node scripts/monitor-liquidity.ts --min-sol 25                 # raise threshold
 *   ts-node scripts/monitor-liquidity.ts --rpc <https> --ws <wss>     # paid RPC
 *   ts-node scripts/monitor-liquidity.ts --dex raydium-amm,pumpfun    # subset
 *   ts-node scripts/monitor-liquidity.ts --types INIT,MIGRATE         # filter event types
 *   ts-node scripts/monitor-liquidity.ts --max-inflight 32            # raise concurrency on a paid RPC
 *   ts-node scripts/monitor-liquidity.ts --raw                        # also dump raw logs (discovery)
 *
 * NOTE: public mainnet-beta RPC drops WebSocket subscriptions under load and
 * rate-limits getParsedTransaction. For real use, point --rpc / --ws at a
 * Helius / QuickNode / Triton endpoint.
 */

import {
  Connection,
  PublicKey,
  type Logs,
  type Commitment,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// DEX / launchpad registry
// ---------------------------------------------------------------------------
//
// Each event has one or more `signatures` - case-insensitive substrings that
// the program emits inside its logs when that event fires. Anchor programs
// emit `Program log: Instruction: <Name>`; legacy programs (Raydium AMM v4,
// pump.fun) emit snake_case discriminator strings.
//
// Adding a new program: pick a known event tx on Solscan, copy the log line
// that's unique to that instruction, drop the unique substring in here.

type EventType = "INIT" | "DEPOSIT" | "MIGRATE" | "CREATE";

interface EventRule {
  type: EventType;
  signatures: string[];
}

interface DexEntry {
  key: string;
  name: string;
  programId: string;
  events: EventRule[];
}

const DEXES: DexEntry[] = [
  {
    key: "raydium-amm",
    name: "Raydium AMM v4",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    events: [
      { type: "INIT", signatures: ["initialize2", "init_pc_amount"] },
      { type: "DEPOSIT", signatures: ["Instruction: Deposit", "ray_log"] },
    ],
  },
  {
    key: "raydium-cpmm",
    name: "Raydium CPMM",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    events: [
      { type: "INIT", signatures: ["Instruction: Initialize", "Instruction: CreatePool"] },
      { type: "DEPOSIT", signatures: ["Instruction: Deposit"] },
    ],
  },
  {
    key: "raydium-clmm",
    name: "Raydium CLMM",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    events: [
      { type: "INIT", signatures: ["Instruction: CreatePool"] },
      {
        type: "DEPOSIT",
        signatures: [
          "Instruction: OpenPosition",
          "Instruction: OpenPositionWithToken22Nft",
          "Instruction: IncreaseLiquidity",
        ],
      },
    ],
  },
  {
    key: "orca-whirlpool",
    name: "Orca Whirlpool",
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    events: [
      {
        type: "INIT",
        signatures: ["Instruction: InitializePool", "Instruction: InitializePoolV2"],
      },
      {
        type: "DEPOSIT",
        signatures: ["Instruction: IncreaseLiquidity", "Instruction: IncreaseLiquidityV2"],
      },
    ],
  },
  {
    key: "meteora-dlmm",
    name: "Meteora DLMM",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    events: [
      {
        type: "INIT",
        signatures: ["Instruction: InitializeLbPair", "Instruction: InitializePermissionLbPair"],
      },
      {
        type: "DEPOSIT",
        signatures: ["Instruction: AddLiquidity", "Instruction: AddLiquidityByStrategy"],
      },
    ],
  },
  {
    key: "meteora-damm-v2",
    name: "Meteora DAMM v2",
    programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    events: [
      { type: "INIT", signatures: ["Instruction: InitializePool", "Instruction: CreatePool"] },
      { type: "DEPOSIT", signatures: ["Instruction: AddLiquidity"] },
    ],
  },
  {
    key: "pumpfun",
    name: "Pump.fun",
    programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    events: [
      // pump.fun emits snake_case discriminators in its logs.
      { type: "CREATE", signatures: ["create_v2", "Instruction: CreateV2", "Instruction: Create"] },
      {
        type: "MIGRATE",
        signatures: ["migrate_v2", "Instruction: MigrateV2", "Instruction: Migrate"],
      },
    ],
  },
  {
    key: "pumpswap",
    name: "PumpSwap AMM",
    programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    events: [
      { type: "INIT", signatures: ["Instruction: CreatePool"] },
      // The 'deposit' event from the user-reported tx is how PumpSwap logs LP adds.
      { type: "DEPOSIT", signatures: ["Instruction: Deposit"] },
    ],
  },
];

const WSOL = "So11111111111111111111111111111111111111112";
const STABLE_MINTS = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Args {
  rpc: string;
  ws: string;
  commitment: Commitment;
  selected: DexEntry[];
  types: Set<EventType> | null;
  minSol: number;
  maxInflight: number;
  raw: boolean;
  color: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const rpc =
    get("--rpc") || process.env.SOLANA_RPC_HTTP_URL || "https://api.mainnet-beta.solana.com";
  const ws = get("--ws") || process.env.SOLANA_RPC_WS_URL || rpc.replace(/^http/, "ws");
  const commitment = (get("--commitment") as Commitment) || "confirmed";
  const minSol = parseFloat(get("--min-sol") || "10");
  const maxInflight = parseInt(get("--max-inflight") || "4", 10);

  const dexArg = get("--dex");
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

  const typesArg = get("--types");
  const types = typesArg
    ? new Set(typesArg.split(",").map((s) => s.trim().toUpperCase()) as EventType[])
    : null;

  return {
    rpc,
    ws,
    commitment,
    selected,
    types,
    minSol,
    maxInflight: Number.isFinite(maxInflight) && maxInflight > 0 ? maxInflight : 4,
    raw: has("--raw"),
    color: !has("--no-color") && process.stdout.isTTY,
  };
}

// ---------------------------------------------------------------------------
// Pretty output
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function color(useColor: boolean, code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}

function shortKey(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function ts(): string {
  // HH:MM:SS local time — compact and readable.
  return new Date().toTimeString().slice(0, 8);
}

const EVENT_COLOR: Record<EventType, string> = {
  INIT: ANSI.green,
  CREATE: ANSI.green,
  DEPOSIT: ANSI.cyan,
  MIGRATE: ANSI.yellow,
};

// ---------------------------------------------------------------------------
// SOL value + token extraction
// ---------------------------------------------------------------------------

/**
 * Estimate the SOL value moved in a transaction.
 *
 *   wsolFlow   = sum of positive WSOL balance deltas across all accounts.
 *                (Total in == total out, so picking one side gives the size of
 *                 the flow without double-counting.)
 *   nativeFlow = sum of positive native-SOL balance deltas (in lamports).
 *                Wrapped/unwrapped SOL shows up here too.
 *
 * We take the max of the two: in most pool-creation / deposit txes the WSOL
 * and native flows are two sides of the same wrap/unwrap, so summing would
 * double-count.
 */
function computeLiquidity(tx: ParsedTransactionWithMeta): {
  sol: number;
  tokens: string[];
  signer: string | null;
} {
  // WSOL token-balance flow, indexed by accountIndex (pre / post may differ in
  // which accounts they list — accountIndex is the stable key).
  const preWsol = new Map<number, number>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.mint === WSOL) preWsol.set(b.accountIndex, Number(b.uiTokenAmount.uiAmount ?? 0));
  }
  let wsolFlow = 0;
  const seen = new Set<number>();
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.mint !== WSOL) continue;
    seen.add(b.accountIndex);
    const post = Number(b.uiTokenAmount.uiAmount ?? 0);
    const pre = preWsol.get(b.accountIndex) ?? 0;
    const delta = post - pre;
    if (delta > 0) wsolFlow += delta;
  }
  // Account closed during the tx (pre exists, post doesn't) — outflow only,
  // already counted on the receiving side.

  // Native SOL flow.
  let nativeLamports = 0;
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  for (let i = 0; i < pre.length; i++) {
    const delta = (post[i] ?? 0) - pre[i];
    if (delta > 0) nativeLamports += delta;
  }
  const nativeSol = nativeLamports / 1e9;

  // Identify non-base mints touched by the tx — these are the "interesting"
  // tokens for a sniper.
  const tokenMints = new Set<string>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.mint && !STABLE_MINTS.has(b.mint)) tokenMints.add(b.mint);
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.mint && !STABLE_MINTS.has(b.mint)) tokenMints.add(b.mint);
  }

  const signer = tx.transaction.message.accountKeys[0]?.pubkey.toString() ?? null;
  return { sol: Math.max(wsolFlow, nativeSol), tokens: [...tokenMints], signer };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function findMatchedEvent(
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, {
    commitment: args.commitment,
    wsEndpoint: args.ws,
  });

  try {
    const slot = await connection.getSlot();
    console.log(
      color(
        args.color,
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
      args.color,
      ANSI.dim,
      `[${ts()}] monitoring ${args.selected.length} programs, min=${args.minSol} SOL, types=${typesHint}, maxInflight=${args.maxInflight}`,
    ),
  );
  for (const d of args.selected) {
    const types = d.events.map((e) => e.type).join("/");
    console.log(
      color(
        args.color,
        ANSI.dim,
        `         ${d.name.padEnd(22)} ${shortKey(d.programId)}  [${types}]`,
      ),
    );
  }
  if (args.raw)
    console.log(color(args.color, ANSI.dim, `[${ts()}] --raw: ALL logs will be printed`));
  console.log("");

  // Per-DEX counters
  const stats: Record<string, { seen: number; reported: number; dropped: number; errors: number }> =
    {};
  for (const d of args.selected) stats[d.key] = { seen: 0, reported: 0, dropped: 0, errors: 0 };

  // Dedupe — onLogs sometimes fires the same signature twice when ws hiccups.
  const seenSigs = new Set<string>();

  // Concurrency cap on getParsedTransaction. Too many in-flight = 429s and a
  // queue of stale fetches. Prefer dropping over queuing — old events are
  // useless for a sniper. Default 4 (sized for public mainnet-beta); raise via
  // --max-inflight on a paid RPC.
  const MAX_INFLIGHT = args.maxInflight;
  let inflight = 0;

  // Silence web3.js's built-in retry chatter — it spam-prints "Server
  // responded with 429" on the public RPC. The library emits these via
  // console.log / .warn / .error depending on version, so patch all three.
  if (!args.raw) {
    const isRetrySpam = (a: unknown[]) =>
      typeof a[0] === "string" &&
      (a[0].startsWith("Server responded with 429") || a[0].startsWith("429 Too Many Requests"));
    for (const method of ["log", "warn", "error"] as const) {
      const orig = console[method];
      console[method] = ((...a: unknown[]) => {
        if (isRetrySpam(a)) return;
        return (orig as (...args: unknown[]) => void)(...a);
      }) as typeof console.log;
    }
  }

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
            color(args.color, ANSI.dim, `[${ts()}] ${dex.key} ${signature} slot=${ctx.slot}`),
          );
          for (const l of logs) console.log(color(args.color, ANSI.dim, `    ${l}`));
        }

        const matched = findMatchedEvent(logs, dex.events);
        if (!matched) return;
        if (args.types && !args.types.has(matched.rule.type)) return;
        if (seenSigs.has(signature)) return;
        seenSigs.add(signature);
        // Trim dedupe set occasionally so it doesn't grow unbounded.
        if (seenSigs.size > 5000) {
          const iter = seenSigs.values();
          for (let i = 0; i < 1000; i++) seenSigs.delete(iter.next().value as string);
        }

        stats[dex.key].seen++;

        if (inflight >= MAX_INFLIGHT) {
          stats[dex.key].dropped++;
          return;
        }
        inflight++;

        // Fetch the parsed tx so we can compute the SOL value. Tiny retry
        // because the tx may not be indexed at our commitment when the log
        // notification arrives.
        let tx: ParsedTransactionWithMeta | null = null;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: args.commitment as any,
              });
              if (tx) break;
            } catch {
              if (attempt === 1) stats[dex.key].errors++;
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        } finally {
          inflight--;
        }

        if (!tx) {
          if (args.raw) {
            console.log(
              color(args.color, ANSI.red, `[${ts()}] ${dex.key} ${signature} tx not visible yet`),
            );
          }
          return;
        }

        const { sol, tokens, signer } = computeLiquidity(tx);
        if (sol < args.minSol) return;

        stats[dex.key].reported++;

        // Pick the most interesting non-base token for display. If the tx
        // touches several (typical for Jupiter routes), the first one is the
        // pool's main token in the vast majority of cases.
        const token = tokens[0];

        const time = color(args.color, ANSI.dim, `[${ts()}]`);
        const dexLabel = color(args.color, ANSI.bold + ANSI.magenta, dex.name.padEnd(18));
        const typeLabel = color(
          args.color,
          EVENT_COLOR[matched.rule.type] + ANSI.bold,
          matched.rule.type.padEnd(8),
        );
        const value = color(args.color, ANSI.bold, `${sol.toFixed(2).padStart(8)} SOL`);
        const tokStr = token
          ? color(args.color, ANSI.white, `tok=${shortKey(token)}`)
          : color(args.color, ANSI.dim, "tok=?");
        const signerStr = signer ? color(args.color, ANSI.dim, `by=${shortKey(signer)}`) : "";
        const sigStr = color(args.color, ANSI.dim, `https://solscan.io/tx/${signature}`);

        console.log(
          `${time}  ${dexLabel} ${typeLabel} ${value}  ${tokStr}  ${signerStr}  ${sigStr}`,
        );
      },
      args.commitment,
    );
  }

  // Periodic heartbeat so an idle terminal stays informative.
  setInterval(() => {
    const parts = Object.entries(stats).map(([k, v]) => {
      const extras = [v.dropped ? `drop=${v.dropped}` : "", v.errors ? `err=${v.errors}` : ""]
        .filter(Boolean)
        .join(",");
      return `${k}=${v.reported}/${v.seen}${extras ? `(${extras})` : ""}`;
    });
    console.log(
      color(args.color, ANSI.dim, `[${ts()}] heartbeat reported/seen: ${parts.join(" ")}`),
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
