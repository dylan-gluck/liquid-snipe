#!/usr/bin/env bun
/**
 * admin/halt.ts — Send a signed halt/resume command to the live runtime.
 *
 * Usage:
 *   bun scripts/admin/halt.ts halt                  # halt all strategies
 *   bun scripts/admin/halt.ts resume                # resume
 *   bun scripts/admin/halt.ts halt --ttl 300        # halt for 5 minutes
 *   bun scripts/admin/halt.ts halt --port 9091      # custom kill-switch port
 *
 * Requires KILLSWITCH_SECRET in env or .env.local.
 */

import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const action = args[0] as "halt" | "resume" | undefined;
if (!action || (action !== "halt" && action !== "resume")) {
  console.error("Usage: bun scripts/admin/halt.ts <halt|resume> [--ttl sec] [--port port]");
  process.exit(1);
}

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]!;
  return fallback;
}

const port = parseInt(getArg("--port", "9091"), 10);
const ttlSec = action === "halt" ? parseInt(getArg("--ttl", "0"), 10) : 0;
const secret = process.env.KILLSWITCH_SECRET ?? "";

if (!secret) {
  console.error("KILLSWITCH_SECRET not set in environment");
  process.exit(1);
}

const body = JSON.stringify({ action, ttlSec: ttlSec > 0 ? ttlSec : undefined });
const signature = createHmac("sha256", secret).update(body).digest("hex");

const resp = await fetch(`http://localhost:${port}/admin/kill`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Signature": signature,
  },
  body,
});

const text = await resp.text();
console.log(`[${resp.status}] ${text}`);
process.exit(resp.ok ? 0 : 1);
