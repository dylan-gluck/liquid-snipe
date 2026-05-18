/**
 * Detection bus: merges WS + gRPC PoolEvent streams, deduplicates by
 * txSignature, and emits each event exactly once.
 */

import type { PoolEvent } from "./types.ts";
import { capturedEvents, detectionSourceWs, detectionSourceGrpc } from "./metrics.ts";

const DEDUP_MAX = 5000;

export interface DetectionBusOpts {
  wsEvents: AsyncIterable<PoolEvent>;
  grpcEvents?: AsyncIterable<PoolEvent>;
  onEvent?: (ev: PoolEvent) => void;
}

export async function* detectionBus(opts: DetectionBusOpts): AsyncGenerator<PoolEvent> {
  const { wsEvents, grpcEvents, onEvent } = opts;

  // Shared queue consumed by the generator, fed by concurrent readers
  const queue: PoolEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  let activeReaders = grpcEvents ? 2 : 1;

  // FIFO dedup: Map preserves insertion order, we evict oldest when over limit
  const seen = new Map<string, true>();

  function push(ev: PoolEvent): void {
    queue.push(ev);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  function readerDone(): void {
    activeReaders--;
    if (activeReaders <= 0) {
      done = true;
      // Wake the consumer so it can exit
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    }
  }

  async function consume(source: AsyncIterable<PoolEvent>): Promise<void> {
    try {
      for await (const ev of source) {
        push(ev);
      }
    } catch {
      // Source errored — treat as ended
    } finally {
      readerDone();
    }
  }

  // Start readers — fire and forget, they push into the queue
  const readers: Promise<void>[] = [consume(wsEvents)];
  if (grpcEvents) readers.push(consume(grpcEvents));

  // Drain loop
  while (true) {
    // Process everything currently in the queue
    while (queue.length > 0) {
      const ev = queue.shift()!;
      const sig = ev.txSignature;

      // Dedup: skip if already seen
      if (seen.has(sig)) continue;

      // Record in dedup set with FIFO eviction
      seen.set(sig, true);
      if (seen.size > DEDUP_MAX) {
        // Delete the oldest entry (first key)
        const first = seen.keys().next().value!;
        seen.delete(first);
      }

      // Update metrics
      capturedEvents.inc();
      if (ev.detectedBy === "ws") detectionSourceWs.inc();
      else if (ev.detectedBy === "grpc") detectionSourceGrpc.inc();

      if (onEvent) onEvent(ev);
      yield ev;
    }

    if (done && queue.length === 0) break;

    // Wait for more items
    await new Promise<void>((r) => {
      resolve = r;
    });
  }

  // Ensure reader promises settle (they should already be done)
  await Promise.allSettled(readers);
}
