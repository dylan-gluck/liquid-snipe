-- 0001_init.sql — bootstrap schema for liquid-snipe live runtime.
-- Executed by scripts/lib/db.ts migration runner.

CREATE TABLE IF NOT EXISTS pool_events (
  signature     TEXT PRIMARY KEY,
  slot          INTEGER NOT NULL,
  dex_key       TEXT    NOT NULL,
  event_type    TEXT    NOT NULL,
  sol_value     REAL    NOT NULL,
  captured_at   TEXT    NOT NULL,
  tokens_json   TEXT    NOT NULL DEFAULT '[]',
  signer        TEXT
);

CREATE TABLE IF NOT EXISTS mint_enrichment (
  mint          TEXT PRIMARY KEY,
  fetched_at    TEXT    NOT NULL,
  mint_auth     TEXT,
  freeze_auth   TEXT,
  decimals      INTEGER NOT NULL DEFAULT 0,
  supply        REAL    NOT NULL DEFAULT 0,
  deployer      TEXT,
  top10         REAL    NOT NULL DEFAULT 0,
  lp_burned     INTEGER,
  expires_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT    NOT NULL,
  mint          TEXT    NOT NULL,
  pool          TEXT    NOT NULL,
  entry_sig     TEXT,
  entry_slot    INTEGER NOT NULL DEFAULT 0,
  entry_price   REAL    NOT NULL DEFAULT 0,
  size_sol      REAL    NOT NULL DEFAULT 0,
  peak_price    REAL    NOT NULL DEFAULT 0,
  realised_frac REAL    NOT NULL DEFAULT 0,
  realised_sol  REAL    NOT NULL DEFAULT 0,
  state         TEXT    NOT NULL DEFAULT 'open',
  opened_at     TEXT    NOT NULL,
  closed_at     TEXT,
  close_reason  TEXT,
  close_sig     TEXT,
  trace_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);
CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy_id);

CREATE TABLE IF NOT EXISTS tx_attempts (
  id            TEXT PRIMARY KEY,
  position_id   TEXT    NOT NULL REFERENCES positions(id),
  kind          TEXT    NOT NULL CHECK(kind IN ('entry', 'exit_partial', 'exit_full')),
  sig           TEXT,
  slot          INTEGER,
  leader        TEXT,
  fee_lamports  INTEGER NOT NULL DEFAULT 0,
  cu_price      INTEGER NOT NULL DEFAULT 0,
  cu_used       INTEGER,
  status        TEXT    NOT NULL DEFAULT 'pending',
  error         TEXT,
  sim_logs_json TEXT,
  created_at    TEXT    NOT NULL,
  trace_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_attempts_position ON tx_attempts(position_id);
CREATE INDEX IF NOT EXISTS idx_tx_attempts_status ON tx_attempts(status);

CREATE TABLE IF NOT EXISTS risk_state (
  date          TEXT PRIMARY KEY,
  pnl_sol       REAL    NOT NULL DEFAULT 0,
  sim_failures  INTEGER NOT NULL DEFAULT 0,
  last_reset    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Track schema version
INSERT OR IGNORE INTO kv(key, value) VALUES ('schema_version', '1');
