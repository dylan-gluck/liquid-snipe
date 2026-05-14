/** Tiny ANSI/format helpers shared by the CLI scripts. */

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

export function color(useColor: boolean, code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}

export function shortKey(addr: string | null | undefined): string {
  if (!addr || addr.length < 12) return addr ?? "";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function fmtSol(x: number, width = 8): string {
  return x.toFixed(2).padStart(width);
}

export function fmtPct(x: number, width = 7): string {
  const sign = x >= 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(1)}%`.padStart(width);
}

export const EVENT_COLOR: Record<string, string> = {
  INIT: ANSI.green,
  CREATE: ANSI.green,
  DEPOSIT: ANSI.cyan,
  MIGRATE: ANSI.yellow,
};
