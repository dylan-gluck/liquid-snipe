#!/usr/bin/env bun
/**
 * signals.ts — CLI inspector for the entry/exit signal evaluators.
 *
 * Reads a captured pool by tx signature (or the newest N captures) from
 * data/pools.jsonl, joins with data/enrich/<mint>.json if present, then
 * runs each strategy's entry rules and prints which fired / failed and
 * what the position size would be.
 *
 * Usage:
 *   bun scripts/signals.ts list                           # newest 20 capture decisions
 *   bun scripts/signals.ts evaluate <txSignature>         # single tx
 *   bun scripts/signals.ts list --limit 50 --strategy S1-pumpfun-grad
 *   bun scripts/signals.ts evaluate <sig> --strategy S2-meteora-dlmm-size
 *
 * No on-chain calls. This is read-only over the captured + enriched data.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getFlag, getInt, hasFlag } from "./lib/cli.ts";
import { ANSI, color, shortKey, ts } from "./lib/format.ts";
import { readJson, readJsonl } from "./lib/storage.ts";
import { STRATEGIES, STRATEGY_BY_ID, evaluateEntry } from "./lib/signals.ts";
import { STABLE_MINTS } from "./lib/dexes.ts";
import type { MintEnrichment, PoolEvent } from "./lib/types.ts";

function loadEnrichment(enrichDir: string, mint: string | null): MintEnrichment | null {
  if (!mint) return null;
  const path = join(enrichDir, `${mint}.json`);
  if (!existsSync(path)) return null;
  return readJson<MintEnrichment | null>(path, null);
}

function pickMint(pool: PoolEvent): string | null {
  return pool.tokens.find((t) => !STABLE_MINTS.has(t)) ?? null;
}

function printPoolHeader(pool: PoolEvent, useColor: boolean): void {
  console.log(
    color(useColor, ANSI.bold, `${pool.dexKey.padEnd(16)}`) +
      ` ${pool.eventType.padEnd(8)} ${pool.solValue.toFixed(2).padStart(7)} SOL  ` +
      color(
        useColor,
        ANSI.dim,
        `tok=${shortKey(pickMint(pool))}  by=${shortKey(pool.signer)}  sig=${shortKey(pool.txSignature)}`,
      ),
  );
}

function evaluatePool(
  pool: PoolEvent,
  enrichment: MintEnrichment | null,
  blocklist: Set<string>,
  filterId: string | undefined,
  useColor: boolean,
): void {
  printPoolHeader(pool, useColor);
  const strategies = filterId ? STRATEGIES.filter((s) => s.id === filterId) : STRATEGIES;
  for (const strat of strategies) {
    const ctx = { pool, enrichment, blocklist };
    const result = evaluateEntry(ctx, strat.entry);
    const size = strat.sizeSol(pool);
    const colorCode = result.ok ? ANSI.green : ANSI.red;
    const label = result.ok ? "ENTER" : "skip ";
    console.log(
      color(useColor, colorCode, `   ${label}`) +
        ` ${strat.id.padEnd(28)} size=${size.toFixed(2)} SOL`,
    );
    for (const r of result.reasons) {
      const ok = result.fired.includes(r);
      console.log(color(useColor, ok ? ANSI.green : ANSI.dim, `      ${ok ? "✓" : "·"} ${r}`));
    }
  }
  console.log("");
}

function cmdList(argv: string[]): void {
  const inPath = getFlag(argv, "--in") || "data/pools.jsonl";
  const enrichDir = getFlag(argv, "--enrich") || "data/enrich";
  const blocklistPath = getFlag(argv, "--blocklist") || "data/blocklist.json";
  const limit = getInt(argv, "--limit", 20);
  const filterId = getFlag(argv, "--strategy");
  const useColor = !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY);

  if (filterId && !STRATEGY_BY_ID[filterId]) {
    console.error(`Unknown strategy ${filterId}. Known: ${STRATEGIES.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  const all = readJsonl<PoolEvent>(inPath);
  if (all.length === 0) {
    console.error(`[${ts()}] no records in ${inPath}`);
    process.exit(1);
  }
  const slice = all.slice(-limit);
  const blocklist = new Set(readJson<string[]>(blocklistPath, []));

  console.log(
    color(
      useColor,
      ANSI.dim,
      `[${ts()}] evaluating ${slice.length} pools (of ${all.length}) against ${filterId ?? "ALL"} strategies`,
    ),
  );
  console.log("");

  for (const pool of slice) {
    const mint = pickMint(pool);
    const enrichment = loadEnrichment(enrichDir, mint);
    evaluatePool(pool, enrichment, blocklist, filterId, useColor);
  }
}

function cmdEvaluate(argv: string[]): void {
  const sig = argv[0];
  if (!sig) {
    console.error("Usage: signals.ts evaluate <txSignature> [--strategy <id>]");
    process.exit(1);
  }
  const inPath = getFlag(argv, "--in") || "data/pools.jsonl";
  const enrichDir = getFlag(argv, "--enrich") || "data/enrich";
  const blocklistPath = getFlag(argv, "--blocklist") || "data/blocklist.json";
  const filterId = getFlag(argv, "--strategy");
  const useColor = !hasFlag(argv, "--no-color") && Boolean(process.stdout.isTTY);

  const all = readJsonl<PoolEvent>(inPath);
  const pool = all.find((p) => p.txSignature === sig);
  if (!pool) {
    console.error(`signature ${sig} not in ${inPath}`);
    process.exit(1);
  }
  const mint = pickMint(pool);
  const enrichment = loadEnrichment(enrichDir, mint);
  const blocklist = new Set(readJson<string[]>(blocklistPath, []));
  evaluatePool(pool, enrichment, blocklist, filterId, useColor);
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub === "evaluate") cmdEvaluate(argv.slice(1));
  else if (sub === "list" || sub === undefined) cmdList(argv.slice(1));
  else {
    console.error(`Unknown subcommand ${sub}. Use 'list' or 'evaluate'.`);
    process.exit(1);
  }
}

main();
