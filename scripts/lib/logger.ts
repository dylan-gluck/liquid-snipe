/**
 * Structured JSON logger — zero external deps.
 *
 * Each log line is a single JSON object with:
 *   level, ts (epoch ms), msg, traceId?, ...extra fields.
 *
 * In dev (LOG_FORMAT=pretty or TTY stdout) falls back to colored one-liners.
 */

type Level = "debug" | "info" | "warn" | "error" | "fatal";
const LEVEL_NUM: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

const LEVEL_COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
};
const RESET = "\x1b[0m";

export interface LogEntry {
  level: Level;
  ts: number;
  msg: string;
  traceId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  fatal(msg: string, extra?: Record<string, unknown>): void;
  child(defaults: Record<string, unknown>): Logger;
}

function isPretty(): boolean {
  if (process.env.LOG_FORMAT === "json") return false;
  if (process.env.LOG_FORMAT === "pretty") return true;
  return Boolean(process.stdout.isTTY);
}

const minLevel: number = LEVEL_NUM[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVEL_NUM.info;

function formatPretty(entry: LogEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const color = LEVEL_COLOR[entry.level] ?? "";
  const trace = entry.traceId ? ` [${entry.traceId.slice(0, 8)}]` : "";
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(entry)) {
    if (k === "level" || k === "ts" || k === "msg" || k === "traceId") continue;
    extra[k] = entry[k];
  }
  const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  return `${color}${time} ${entry.level.toUpperCase().padEnd(5)}${RESET}${trace} ${entry.msg}${extraStr}`;
}

function emit(entry: LogEntry): void {
  if (isPretty()) {
    const line = formatPretty(entry);
    if (entry.level === "error" || entry.level === "fatal") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  } else {
    const line = JSON.stringify(entry);
    if (entry.level === "error" || entry.level === "fatal") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}

function createLogger(defaults: Record<string, unknown> = {}): Logger {
  const log = (level: Level, msg: string, extra?: Record<string, unknown>): void => {
    if (LEVEL_NUM[level] < minLevel) return;
    const entry: LogEntry = { level, ts: Date.now(), msg, ...defaults, ...extra };
    emit(entry);
  };

  return {
    debug: (msg, extra?) => log("debug", msg, extra),
    info: (msg, extra?) => log("info", msg, extra),
    warn: (msg, extra?) => log("warn", msg, extra),
    error: (msg, extra?) => log("error", msg, extra),
    fatal: (msg, extra?) => log("fatal", msg, extra),
    child(childDefaults) {
      return createLogger({ ...defaults, ...childDefaults });
    },
  };
}

/** Root logger. Callers use `log.child({ component: "rpc" })` for scoped logging. */
export const log: Logger = createLogger();

/** Generate a ULID-style trace ID. 10-char Crockford base32 timestamp + 16-char random. */
export function traceId(): string {
  const t = Date.now();
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = "";
  let n = t;
  for (let i = 0; i < 10; i++) {
    ts = ENCODING[n & 31]! + ts;
    n = Math.floor(n / 32);
  }
  let rand = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (let i = 0; i < 16; i++) {
    rand += ENCODING[bytes[i % 10]! & 31];
  }
  return ts + rand;
}
