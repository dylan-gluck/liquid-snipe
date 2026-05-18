#!/usr/bin/env bun
/**
 * admin/fund-hot.ts — Manual script to check hot wallet balances.
 *
 * Lists all configured hot wallets and their SOL balances.
 * Actual funding (treasury → hot) is done manually via CLI or Phantom
 * to keep the treasury keypair offline.
 *
 * Usage:
 *   bun scripts/admin/fund-hot.ts
 *   bun scripts/admin/fund-hot.ts --config config.yaml
 */

import { Connection, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "../lib/config.ts";

const configPath = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : undefined;

const config = loadConfig(configPath);
const rpcUrl = config.rpc.httpUrls[0] ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, config.rpc.commitment);

console.log("Hot wallet balances:");
console.log("─".repeat(60));

if (config.wallet.keypairPaths.length === 0) {
  console.log("  No wallet keypair paths configured.");
  console.log("  Add paths to config.yaml under wallet.keypairPaths");
  process.exit(0);
}

for (const path of config.wallet.keypairPaths) {
  if (!existsSync(path)) {
    console.log(`  ${path}: FILE NOT FOUND`);
    continue;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    const balance = await connection.getBalance(kp.publicKey);
    const sol = balance / LAMPORTS_PER_SOL;
    const status = sol < config.wallet.minBalanceSol ? "⚠ LOW" : "✓";
    console.log(`  ${kp.publicKey.toBase58()}: ${sol.toFixed(4)} SOL ${status}`);
  } catch (err) {
    console.log(`  ${path}: ERROR ${String(err)}`);
  }
}

console.log("─".repeat(60));
console.log(`Min balance threshold: ${config.wallet.minBalanceSol} SOL`);
