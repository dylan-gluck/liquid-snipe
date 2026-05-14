/**
 * Helius SDK helpers. Loads HELIUS_API_KEY from environment (or .env.local
 * dropped at repo root) and constructs a configured client.
 *
 * The capture / enrich / snapshot scripts route everything through Helius
 * so we benefit from the higher rate limits + Enhanced WebSockets when
 * available. If no API key is found the client still works but is pointed
 * at the public Helius endpoint with no auth (basic rate limit).
 */

import { createHelius, type HeliusClient } from "helius-sdk";
import { existsSync, readFileSync } from "node:fs";

const ENV_PATH = ".env.local";

/** Pulls HELIUS_API_KEY from env first, then `.env.local` (only that one var
 *  — we don't want to silently shadow OS env vars). */
export function loadApiKey(): string | undefined {
  const fromEnv = process.env.HELIUS_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (!existsSync(ENV_PATH)) return undefined;
  const text = readFileSync(ENV_PATH, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*HELIUS_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m) return m[1];
  }
  return undefined;
}

export interface HeliusOpts {
  /** Forces a specific API key, overriding env. */
  apiKey?: string;
  /** "mainnet" (default) or "devnet". */
  network?: "mainnet" | "devnet";
  /** Identifier sent as X-Helius-Client. */
  userAgent?: string;
}

export function makeHelius(opts: HeliusOpts = {}): HeliusClient {
  const apiKey = opts.apiKey ?? loadApiKey();
  return createHelius({
    apiKey: apiKey ?? "",
    network: opts.network ?? "mainnet",
    userAgent: opts.userAgent ?? "liquid-snipe/0.2",
  });
}
