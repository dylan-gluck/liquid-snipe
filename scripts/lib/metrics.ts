/**
 * Prometheus-format metrics exposition over Bun HTTP on :9090/metrics.
 *
 * Lightweight, zero-dep. Supports counters, gauges, and histograms.
 */

import { log } from "./logger.ts";

// ─── Metric types ──────────────────────────────────────────────────

export interface Counter {
  inc(n?: number): void;
  value(): number;
}

export interface Gauge {
  set(n: number): void;
  inc(n?: number): void;
  dec(n?: number): void;
  value(): number;
}

export interface Histogram {
  observe(value: number): void;
  /** Returns [sum, count, buckets] for exposition. */
  snapshot(): { sum: number; count: number; buckets: Array<{ le: number; count: number }> };
}

// ─── Registry ──────────────────────────────────────────────────────

interface MetricDef {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  render(): string;
}

const registry: MetricDef[] = [];

function renderAll(): string {
  const parts: string[] = [];
  for (const m of registry) {
    parts.push(`# HELP ${m.name} ${m.help}`);
    parts.push(`# TYPE ${m.name} ${m.type}`);
    parts.push(m.render());
  }
  return parts.join("\n") + "\n";
}

// ─── Factory ───────────────────────────────────────────────────────

export function createCounter(name: string, help: string): Counter {
  let val = 0;
  const c: Counter = {
    inc(n = 1) {
      val += n;
    },
    value() {
      return val;
    },
  };
  registry.push({
    name,
    help,
    type: "counter",
    render: () => `${name} ${val}`,
  });
  return c;
}

export function createGauge(name: string, help: string): Gauge {
  let val = 0;
  const g: Gauge = {
    set(n) {
      val = n;
    },
    inc(n = 1) {
      val += n;
    },
    dec(n = 1) {
      val -= n;
    },
    value() {
      return val;
    },
  };
  registry.push({
    name,
    help,
    type: "gauge",
    render: () => `${name} ${val}`,
  });
  return g;
}

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function createHistogram(
  name: string,
  help: string,
  buckets: number[] = DEFAULT_BUCKETS,
): Histogram {
  const sorted = [...buckets].sort((a, b) => a - b);
  const counts = new Float64Array(sorted.length + 1); // last = +Inf
  let sum = 0;
  let count = 0;

  const h: Histogram = {
    observe(value) {
      sum += value;
      count++;
      for (let i = 0; i < sorted.length; i++) {
        if (value <= sorted[i]!) counts[i] = (counts[i] ?? 0) + 1;
      }
      counts[sorted.length] = (counts[sorted.length] ?? 0) + 1; // +Inf
    },
    snapshot() {
      return {
        sum,
        count,
        buckets: sorted.map((le, i) => ({ le, count: counts[i]! })),
      };
    },
  };

  registry.push({
    name,
    help,
    type: "histogram",
    render() {
      const lines: string[] = [];
      for (let i = 0; i < sorted.length; i++) {
        lines.push(`${name}_bucket{le="${sorted[i]}"} ${counts[i]}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${counts[sorted.length]}`);
      lines.push(`${name}_sum ${sum}`);
      lines.push(`${name}_count ${count}`);
      return lines.join("\n");
    },
  });
  return h;
}

// ─── Well-known metrics ────────────────────────────────────────────

export const detectToDecisionMs = createHistogram(
  "detect_to_decision_ms",
  "Detect to decision latency in ms",
  [1, 5, 10, 25, 50, 100, 250, 500],
);
export const decisionToBroadcastMs = createHistogram(
  "decision_to_broadcast_ms",
  "Decision to broadcast latency in ms",
  [5, 10, 25, 50, 100, 250, 500, 1000],
);
export const txConfirmRank = createHistogram(
  "tx_confirm_rank",
  "Transaction confirmation rank",
  [1, 3, 5, 10, 20, 50, 100],
);
export const revertRate = createGauge("revert_rate", "Transaction revert rate");
export const rpcP50Ms = createGauge("rpc_p50_ms", "RPC p50 latency in ms");
export const rpcP95Ms = createGauge("rpc_p95_ms", "RPC p95 latency in ms");
export const slotLag = createGauge("slot_lag", "Current slot lag");
export const dailyPnlSol = createGauge("daily_pnl_sol", "Daily realized PnL in SOL");
export const openPositions = createGauge("open_positions", "Currently open positions");
export const capturedEvents = createCounter("captured_events_total", "Total pool events captured");
export const detectionSourceWs = createCounter(
  "detection_source_ws_total",
  "Events first seen via WS",
);
export const detectionSourceGrpc = createCounter(
  "detection_source_grpc_total",
  "Events first seen via gRPC",
);

// ─── HTTP server ───────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;

export function startMetricsServer(port = 9090): void {
  if (server) return;
  server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        return new Response(renderAll(), {
          headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (url.pathname === "/health") {
        return new Response("ok");
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  log.info("metrics server started", { port });
}

export function stopMetricsServer(): void {
  if (server) {
    void server.stop(true);
    server = null;
  }
}

/** Render all metrics as a string (for tests / debugging without HTTP). */
export function scrape(): string {
  return renderAll();
}
