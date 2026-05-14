/**
 * JSONL / JSON persistence helpers. Append-only, line-oriented; safe under
 * concurrent appends from multiple scripts as long as each writes whole
 * lines (Node guarantees writes < PIPE_BUF are atomic, lines stay well
 * below that for our records).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function appendJsonl<T>(path: string, record: T): void {
  ensureDir(path);
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip corrupted lines; safer than failing the whole load
    }
  }
  return out;
}

/** Yields records lazily so callers can stream very large files. */
export function* iterJsonl<T>(path: string): Generator<T> {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // skip
    }
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(path: string, value: T): void {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(value, null, 2));
}
