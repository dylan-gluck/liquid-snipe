-- 0002_add_position_dex_key.sql — add dex_key + baseline_quote_reserve to positions table.
-- Safe to re-run: ALTER TABLE with IF NOT EXISTS via try pattern handled by bun:sqlite.

-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, but it will silently
-- error on duplicate column with the migration runner's try/catch.
-- We use a separate statement per column so partial application is safe.
ALTER TABLE positions ADD COLUMN dex_key TEXT NOT NULL DEFAULT '';
ALTER TABLE positions ADD COLUMN baseline_quote_reserve REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN token_amount REAL NOT NULL DEFAULT 0;
