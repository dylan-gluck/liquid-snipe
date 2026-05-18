/**
 * SQLite wrapper using bun:sqlite. WAL mode, migration runner.
 *
 * Single-connection model (Bun's SQLite is synchronous + in-process,
 * WAL enables concurrent readers).
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.ts";
import { ensureDir } from "./storage.ts";
import { dirname } from "node:path";

let _db: Database | null = null;

export function openDb(dbPath: string): Database {
  if (_db) return _db;

  ensureDir(dirname(dbPath));
  _db = new Database(dbPath, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");

  log.info("database opened", { path: dbPath, mode: "WAL" });
  return _db;
}

export function getDb(): Database {
  if (!_db) throw new Error("Database not opened. Call openDb() first.");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("database closed");
  }
}

// ─── Migration runner ──────────────────────────────────────────────

export function runMigrations(db: Database, migrationsDir = "migrations"): void {
  if (!existsSync(migrationsDir)) {
    log.warn("migrations dir not found", { dir: migrationsDir });
    return;
  }

  // Ensure the migrations tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .query("SELECT name FROM _migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(
        `INSERT INTO _migrations(name, applied_at) VALUES ('${file}', '${new Date().toISOString()}')`,
      );
      db.exec("COMMIT");
      log.info("migration applied", { file });
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${String(err)}`);
    }
  }
}

// ─── Typed helpers ─────────────────────────────────────────────────

export function kvGet(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function kvSet(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)").run(key, value);
}

export function insertPoolEvent(
  db: Database,
  ev: {
    signature: string;
    slot: number;
    dexKey: string;
    eventType: string;
    solValue: number;
    capturedAt: string;
    tokens: string[];
    signer: string | null;
  },
): void {
  db.query(
    `INSERT OR IGNORE INTO pool_events(signature, slot, dex_key, event_type, sol_value, captured_at, tokens_json, signer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.signature,
    ev.slot,
    ev.dexKey,
    ev.eventType,
    ev.solValue,
    ev.capturedAt,
    JSON.stringify(ev.tokens),
    ev.signer,
  );
}

export function upsertMintEnrichment(
  db: Database,
  e: {
    mint: string;
    fetchedAt: string;
    mintAuth: string | null;
    freezeAuth: string | null;
    decimals: number;
    supply: number;
    deployer: string | null;
    top10: number;
    lpBurned: boolean | null;
    expiresAt: string;
  },
): void {
  db.query(
    `INSERT OR REPLACE INTO mint_enrichment(mint, fetched_at, mint_auth, freeze_auth, decimals, supply, deployer, top10, lp_burned, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.mint,
    e.fetchedAt,
    e.mintAuth,
    e.freezeAuth,
    e.decimals,
    e.supply,
    e.deployer,
    e.top10,
    e.lpBurned === null ? null : e.lpBurned ? 1 : 0,
    e.expiresAt,
  );
}

export function insertPosition(
  db: Database,
  p: {
    id: string;
    strategyId: string;
    mint: string;
    pool: string;
    entrySig: string | null;
    entrySlot: number;
    entryPrice: number;
    sizeSol: number;
    openedAt: string;
    traceId?: string;
    dexKey?: string;
    baselineQuoteReserve?: number;
    tokenAmount?: number;
  },
): void {
  db.query(
    `INSERT INTO positions(id, strategy_id, mint, pool, entry_sig, entry_slot, entry_price, size_sol, peak_price, realised_frac, realised_sol, state, opened_at, trace_id, dex_key, baseline_quote_reserve, token_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.strategyId,
    p.mint,
    p.pool,
    p.entrySig,
    p.entrySlot,
    p.entryPrice,
    p.sizeSol,
    p.entryPrice,
    p.openedAt,
    p.traceId ?? null,
    p.dexKey ?? "",
    p.baselineQuoteReserve ?? 0,
    p.tokenAmount ?? 0,
  );
}

export function updatePositionClose(
  db: Database,
  id: string,
  update: {
    peakPrice: number;
    realisedFrac: number;
    realisedSol: number;
    state: string;
    closedAt: string;
    closeReason: string;
    closeSig: string | null;
  },
): void {
  db.query(
    `UPDATE positions SET peak_price=?, realised_frac=?, realised_sol=?, state=?, closed_at=?, close_reason=?, close_sig=? WHERE id=?`,
  ).run(
    update.peakPrice,
    update.realisedFrac,
    update.realisedSol,
    update.state,
    update.closedAt,
    update.closeReason,
    update.closeSig,
    id,
  );
}

export function insertTxAttempt(
  db: Database,
  a: {
    id: string;
    positionId: string;
    kind: "entry" | "exit_partial" | "exit_full";
    sig: string | null;
    slot: number | null;
    leader: string | null;
    feeLamports: number;
    cuPrice: number;
    cuUsed: number | null;
    status: string;
    error: string | null;
    simLogsJson: string | null;
    createdAt: string;
    traceId?: string;
  },
): void {
  db.query(
    `INSERT OR IGNORE INTO tx_attempts(id, position_id, kind, sig, slot, leader, fee_lamports, cu_price, cu_used, status, error, sim_logs_json, created_at, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id,
    a.positionId,
    a.kind,
    a.sig,
    a.slot,
    a.leader,
    a.feeLamports,
    a.cuPrice,
    a.cuUsed,
    a.status,
    a.error,
    a.simLogsJson,
    a.createdAt,
    a.traceId ?? null,
  );
}

export function getOpenPositions(db: Database): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM positions WHERE state = 'open'").all() as Array<
    Record<string, unknown>
  >;
}

export function getRiskState(
  db: Database,
  date: string,
): { pnlSol: number; simFailures: number; lastReset: string } | null {
  const row = db
    .query("SELECT pnl_sol, sim_failures, last_reset FROM risk_state WHERE date = ?")
    .get(date) as {
    pnl_sol: number;
    sim_failures: number;
    last_reset: string;
  } | null;
  if (!row) return null;
  return { pnlSol: row.pnl_sol, simFailures: row.sim_failures, lastReset: row.last_reset };
}

export function upsertRiskState(
  db: Database,
  date: string,
  pnlSol: number,
  simFailures: number,
): void {
  db.query(
    `INSERT INTO risk_state(date, pnl_sol, sim_failures, last_reset)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET pnl_sol=?, sim_failures=?, last_reset=?`,
  ).run(
    date,
    pnlSol,
    simFailures,
    new Date().toISOString(),
    pnlSol,
    simFailures,
    new Date().toISOString(),
  );
}
