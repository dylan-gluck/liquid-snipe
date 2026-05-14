#!/usr/bin/env bun
/**
 * helius-signup.ts
 *
 * Programmatic-signup bootstrap. Three modes:
 *
 *   --use-key <KEY>              Persist a key you already have. Fast path
 *                                when the user obtained one via the dashboard.
 *   --agentic                    Use helius-sdk/auth/client agenticSignup()
 *                                end-to-end — generates a keypair, performs
 *                                USDC payment on-chain (if balance present),
 *                                returns provisioned API key.
 *   (default)                    `agenticSignup` in dry-run-ish mode: runs
 *                                the wallet signup + project lookup. If the
 *                                wallet already has a project, persists the
 *                                API key; otherwise prints the next step.
 *
 *  Output: .env.local with HELIUS_API_KEY=… plus HELIUS_WALLET / HELIUS_PROJECT_ID.
 *  Persistent keypair at .helius-keypair.json (0o600) so reruns are stable.
 *
 *  All plans (including `agent`) require USDC payment; agenticSignup uses
 *  the keypair's own SOL+USDC balance for the on-chain transfer.
 */

import { makeAuthClient } from "helius-sdk/auth/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getFlag, hasFlag } from "./lib/cli.ts";
import { ANSI, color, ts } from "./lib/format.ts";

const ENV_PATH = ".env.local";
const KEYPAIR_PATH = ".helius-keypair.json";

interface KeypairFile {
  publicKey: string;
  secretKey: number[];
}

async function loadOrCreateKeypair(
  auth: ReturnType<typeof makeAuthClient>,
): Promise<{ secretKey: Uint8Array; publicKey: string }> {
  if (existsSync(KEYPAIR_PATH)) {
    const file = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as KeypairFile;
    return { secretKey: Uint8Array.from(file.secretKey), publicKey: file.publicKey };
  }
  const kp = await auth.generateKeypair();
  const address = await auth.getAddress(kp);
  writeFileSync(
    KEYPAIR_PATH,
    JSON.stringify({ publicKey: address, secretKey: Array.from(kp.secretKey) }, null, 2),
    { mode: 0o600 },
  );
  return { secretKey: kp.secretKey, publicKey: address };
}

function persistEnv(updates: Record<string, string>): void {
  const lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (m && updates[m[1]!] !== undefined) continue;
      if (line.trim().length > 0) lines.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) lines.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

async function main() {
  const argv = process.argv.slice(2);

  const explicit = getFlag(argv, "--use-key");
  if (explicit) {
    persistEnv({ HELIUS_API_KEY: explicit });
    console.log(`[${ts()}] wrote HELIUS_API_KEY to ${ENV_PATH}`);
    return;
  }

  const plan = getFlag(argv, "--plan") ?? "agent";
  const email = getFlag(argv, "--email");
  const first = getFlag(argv, "--first");
  const last = getFlag(argv, "--last");
  const verbose = hasFlag(argv, "--verbose");

  const auth = makeAuthClient("liquid-snipe/0.2");
  const kp = await loadOrCreateKeypair(auth);
  console.log(color(true, ANSI.dim, `[${ts()}] wallet=${kp.publicKey}`));

  // agenticSignup handles the full flow: walletSignup → listProjects →
  // (if no project) createProject + USDC pay → createApiKey. The wallet
  // must hold sufficient USDC + SOL.
  const result = await auth.agenticSignup({
    secretKey: kp.secretKey,
    plan,
    ...(email ? { email } : {}),
    ...(first ? { firstName: first } : {}),
    ...(last ? { lastName: last } : {}),
  });

  if (verbose) console.log(JSON.stringify(result, null, 2));

  if (result.apiKey) {
    persistEnv({
      HELIUS_API_KEY: result.apiKey,
      HELIUS_WALLET: result.walletAddress,
      HELIUS_PROJECT_ID: result.projectId,
    });
    console.log(
      color(true, ANSI.green, `[${ts()}] ${result.status}; HELIUS_API_KEY written to ${ENV_PATH}`),
    );
    if (result.endpoints) {
      console.log(`  mainnet: ${result.endpoints.mainnet}`);
      console.log(`  devnet : ${result.endpoints.devnet}`);
    }
    if (result.credits !== null) console.log(`  credits: ${result.credits}`);
  } else {
    console.log(
      color(true, ANSI.yellow, `[${ts()}] signup returned no apiKey (status=${result.status}).`),
    );
    console.log(`  Fund wallet ${result.walletAddress} with USDC + SOL and rerun.`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[${ts()}] signup failed: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
