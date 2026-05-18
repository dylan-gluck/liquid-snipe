/**
 * HTTP kill-switch endpoint + file watcher. Provides multiple ways to
 * halt/resume the trading system: file presence, HTTP POST with HMAC auth,
 * or programmatic API.
 */

import { existsSync, watch } from "node:fs";
import { createHmac } from "node:crypto";
import { log } from "./logger.ts";
import { kvSet, kvGet, getDb } from "./db.ts";
import type { FSWatcher } from "node:fs";
import { dirname } from "node:path";

const HALTED_KEY = "halted";

export class KillSwitch {
  private readonly hmacSecret: string | undefined;
  private readonly haltFilePath: string;
  private readonly kslog = log.child({ component: "killswitch" });
  private watcher: FSWatcher | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hmacSecret: string | undefined, haltFilePath: string) {
    this.hmacSecret = hmacSecret;
    this.haltFilePath = haltFilePath;
  }

  /**
   * Watch for presence of haltFilePath.
   * File appears → halt. File removed → resume.
   */
  startFileWatcher(): void {
    // Check current state on start
    if (existsSync(this.haltFilePath)) {
      this.halt("halt file present on startup");
    }

    try {
      const dir = dirname(this.haltFilePath);
      this.watcher = watch(dir, (_eventType, filename) => {
        // Only react to our halt file
        const base = this.haltFilePath.split("/").pop() ?? this.haltFilePath;
        if (filename !== base) return;

        if (existsSync(this.haltFilePath)) {
          this.halt("halt file detected");
        } else {
          this.resume();
        }
      });
      this.kslog.info("file watcher started", { path: this.haltFilePath });
    } catch (err) {
      this.kslog.warn("could not start file watcher — directory may not exist", {
        err,
        path: this.haltFilePath,
      });
    }
  }

  /**
   * Start HTTP endpoint for remote halt/resume via authenticated POST.
   */
  startHttpEndpoint(port: number): void {
    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/admin/kill") {
          return this.handleKillRequest(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    this.kslog.info("kill-switch HTTP endpoint started", { port });
  }

  /** Programmatic halt. */
  halt(reason?: string): void {
    const db = getDb();
    kvSet(db, HALTED_KEY, reason ?? "manual halt");
    this.kslog.warn("HALT — trading suspended", { reason: reason ?? "manual halt" });
  }

  /** Programmatic resume. */
  resume(): void {
    const db = getDb();
    db.query("DELETE FROM kv WHERE key = ?").run(HALTED_KEY);
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.kslog.info("RESUME — trading active");
  }

  /** Check halt state. */
  isHalted(): boolean {
    return kvGet(getDb(), HALTED_KEY) !== null;
  }

  /** Stop watcher + HTTP server. */
  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.server) {
      void this.server.stop();
      this.server = null;
    }
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.kslog.info("kill-switch closed");
  }

  // ─── internal ────────────────────────────────────────────────────

  private async handleKillRequest(req: Request): Promise<Response> {
    // HMAC authentication required
    if (!this.hmacSecret) {
      return new Response(
        JSON.stringify({ error: "HMAC secret not configured — all requests rejected" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const signature = req.headers.get("X-Signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "missing X-Signature header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.text();

    // Verify HMAC-SHA256
    const expected = createHmac("sha256", this.hmacSecret).update(body).digest("hex");
    if (!timingSafeEqual(signature, expected)) {
      return new Response(JSON.stringify({ error: "invalid signature" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    let payload: { action?: string; strategyId?: string; ttlSec?: number };
    try {
      payload = JSON.parse(body) as { action?: string; strategyId?: string; ttlSec?: number };
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { action, strategyId, ttlSec } = payload;

    if (action === "halt") {
      const reason = strategyId ? `HTTP halt: strategy=${strategyId}` : "HTTP halt: all strategies";
      this.halt(reason);

      // Schedule auto-resume if TTL provided
      if (ttlSec && ttlSec > 0) {
        if (this.ttlTimer) clearTimeout(this.ttlTimer);
        this.ttlTimer = setTimeout(() => {
          this.resume();
          this.kslog.info("TTL expired — auto-resumed", { ttlSec });
        }, ttlSec * 1000);
      }

      this.kslog.info("audit: halt via HTTP", { action, strategyId, ttlSec });
      return new Response(JSON.stringify({ ok: true, action: "halt" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "resume") {
      this.resume();
      this.kslog.info("audit: resume via HTTP", { action, strategyId });
      return new Response(JSON.stringify({ ok: true, action: "resume" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "action must be 'halt' or 'resume'" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Constant-time string comparison to prevent timing attacks on HMAC.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
