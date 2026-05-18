/**
 * RPC connection pool with health-aware routing.
 *
 * Tracks per-provider latency, error rate, and slot lag. Routes requests
 * to the healthiest provider by weighted score.
 */

import {
  Connection,
  type Commitment,
  type PublicKey,
  type AccountInfo,
  type SendOptions,
} from "@solana/web3.js";
import type { Buffer } from "node:buffer";
import { log } from "./logger.ts";
import { rpcP50Ms, rpcP95Ms } from "./metrics.ts";

const RING_SIZE = 100;
const HEALTH_INTERVAL_MS = 10_000;
const BLOCKHASH_TTL_MS = 2_000;

interface ProviderState {
  url: string;
  conn: Connection;
  /** Ring buffer of recent call latencies in ms. */
  latencies: Float64Array;
  latIdx: number;
  latCount: number;
  errorCount: number;
  callCount: number;
  lastSlot: number;
}

function percentile(ring: Float64Array, count: number, pct: number): number {
  if (count === 0) return Infinity;
  const n = Math.min(count, ring.length);
  // Copy the filled portion and sort
  const sorted = new Float64Array(n);
  const start = count <= ring.length ? 0 : count % ring.length;
  for (let i = 0; i < n; i++) {
    sorted[i] = ring[(start + i) % ring.length]!;
  }
  sorted.sort();
  const idx = Math.min(Math.floor(pct * n), n - 1);
  return sorted[idx]!;
}

function providerScore(p: ProviderState, maxSlot: number, maxSlotLag: number): number {
  const p50 = percentile(p.latencies, p.latCount, 0.5);
  const errRate = p.callCount > 0 ? p.errorCount / p.callCount : 0;
  const lag = maxSlot > 0 ? maxSlot - p.lastSlot : 0;

  // Lower is better. Latency baseline + penalties.
  let score = p50;
  // Error penalty: 500ms per 10% error rate
  score += errRate * 5000;
  // Slot lag penalty: 200ms per slot behind
  if (lag > maxSlotLag) score += (lag - maxSlotLag) * 200;
  return score;
}

function recordCall(p: ProviderState, latencyMs: number, ok: boolean): void {
  p.latencies[p.latIdx % RING_SIZE] = latencyMs;
  p.latIdx++;
  p.latCount++;
  p.callCount++;
  if (!ok) p.errorCount++;
}

export class RpcPool {
  private providers: ProviderState[];
  private commitment: Commitment;
  private maxSlotLag: number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private logger = log.child({ component: "rpc-pool" });

  // Blockhash cache
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
  private blockhashExpiry = 0;

  constructor(urls: string[], commitment: Commitment, maxSlotLag: number) {
    if (urls.length === 0) throw new Error("RpcPool requires at least one URL");
    this.commitment = commitment;
    this.maxSlotLag = maxSlotLag;
    this.providers = urls.map((url) => ({
      url,
      conn: new Connection(url, { commitment }),
      latencies: new Float64Array(RING_SIZE),
      latIdx: 0,
      latCount: 0,
      errorCount: 0,
      callCount: 0,
      lastSlot: 0,
    }));
    this.startHealthLoop();
  }

  /** Returns the healthiest connection. */
  getConnection(): Connection {
    return this.best().conn;
  }

  async getLatestBlockhash(
    commitment?: Commitment,
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this.cachedBlockhash && now < this.blockhashExpiry) {
      return this.cachedBlockhash;
    }
    const p = this.best();
    const t0 = performance.now();
    let ok = true;
    try {
      const result = await p.conn.getLatestBlockhash(commitment ?? this.commitment);
      this.cachedBlockhash = result;
      this.blockhashExpiry = now + BLOCKHASH_TTL_MS;
      return result;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      recordCall(p, performance.now() - t0, ok);
    }
  }

  async getAccountInfo(
    pubkey: PublicKey,
    opts?: { commitment?: Commitment },
  ): Promise<AccountInfo<Buffer> | null> {
    const p = this.best();
    const t0 = performance.now();
    let ok = true;
    try {
      return await p.conn.getAccountInfo(pubkey, opts?.commitment ?? this.commitment);
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      recordCall(p, performance.now() - t0, ok);
    }
  }

  async simulateTransaction(
    tx: Parameters<Connection["simulateTransaction"]>[0],
    opts?: Parameters<Connection["simulateTransaction"]>[1],
  ): Promise<ReturnType<Connection["simulateTransaction"]>> {
    const p = this.best();
    const t0 = performance.now();
    let ok = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (p.conn.simulateTransaction as any)(tx, opts);
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      recordCall(p, performance.now() - t0, ok);
    }
  }

  async sendRawTransaction(raw: Uint8Array | Buffer, opts?: SendOptions): Promise<string> {
    const p = this.best();
    const t0 = performance.now();
    let ok = true;
    try {
      return await p.conn.sendRawTransaction(raw, opts);
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      recordCall(p, performance.now() - t0, ok);
    }
  }

  /**
   * Helius-specific `getPriorityFeeEstimate` JSON-RPC method.
   * Posts to the first URL containing 'helius'. Returns null on failure.
   */
  async getPriorityFeeEstimate(accountKeys: string[]): Promise<number | null> {
    const heliusUrl = this.providers.find((p) => p.url.includes("helius"))?.url;
    if (!heliusUrl) return null;
    try {
      const res = await fetch(heliusUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getPriorityFeeEstimate",
          params: [{ accountKeys, options: { recommended: true } }],
        }),
      });
      const json = (await res.json()) as { result?: { priorityFeeEstimate?: number } };
      return json.result?.priorityFeeEstimate ?? null;
    } catch {
      return null;
    }
  }

  /** True if at least one provider is healthy. */
  healthy(): boolean {
    return this.providers.some((p) => {
      const errRate = p.callCount > 0 ? p.errorCount / p.callCount : 0;
      const maxSlot = Math.max(...this.providers.map((pp) => pp.lastSlot));
      const lag = maxSlot > 0 ? maxSlot - p.lastSlot : 0;
      return errRate < 0.5 && lag <= this.maxSlotLag;
    });
  }

  close(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ── internals ───────────────────────────────────────────────────

  private best(): ProviderState {
    const maxSlot = Math.max(...this.providers.map((p) => p.lastSlot));
    let bestP = this.providers[0]!;
    let bestScore = Infinity;
    for (const p of this.providers) {
      const s = providerScore(p, maxSlot, this.maxSlotLag);
      if (s < bestScore) {
        bestScore = s;
        bestP = p;
      }
    }
    return bestP;
  }

  private startHealthLoop(): void {
    const check = async () => {
      const results = await Promise.allSettled(
        this.providers.map(async (p) => {
          const t0 = performance.now();
          let ok = true;
          try {
            const slot = await p.conn.getSlot(this.commitment);
            p.lastSlot = slot;
          } catch (err) {
            ok = false;
            this.logger.warn("health check failed", { url: p.url, error: String(err) });
          } finally {
            recordCall(p, performance.now() - t0, ok);
          }
        }),
      );
      void results; // allSettled never rejects

      // Update metrics from the best provider
      const bestP = this.best();
      const p50 = percentile(bestP.latencies, bestP.latCount, 0.5);
      const p95 = percentile(bestP.latencies, bestP.latCount, 0.95);
      if (isFinite(p50)) rpcP50Ms.set(p50);
      if (isFinite(p95)) rpcP95Ms.set(p95);
    };

    // Run immediately, then on interval
    void check();
    this.healthTimer = setInterval(() => void check(), HEALTH_INTERVAL_MS);
  }
}
