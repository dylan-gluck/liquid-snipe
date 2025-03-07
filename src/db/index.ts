import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { LiquidityPool, Position, Token, Trade } from '../types';
import { Logger } from '../utils/logger';

// Enable verbose mode for debugging if needed
// sqlite3.verbose();

export class DatabaseManager {
  private db: sqlite3.Database;
  private logger: Logger;
  private initialized = false;

  constructor(dbPath: string) {
    this.logger = new Logger('DatabaseManager');
    
    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.logger.info(`Initializing database at ${dbPath}`);
    this.db = new sqlite3.Database(dbPath, (err: Error | null) => {
      if (err) {
        this.logger.error(`Failed to open database: ${err.message}`);
        throw err;
      }
    });
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Enable foreign keys
        this.db.run('PRAGMA foreign_keys = ON');

        // Create tokens table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS tokens (
            address TEXT PRIMARY KEY,
            symbol TEXT,
            name TEXT,
            decimals INTEGER,
            first_seen INTEGER,
            is_verified BOOLEAN DEFAULT 0,
            metadata TEXT
          )
        `);

        // Create liquidity_pools table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS liquidity_pools (
            address TEXT PRIMARY KEY,
            dex_name TEXT,
            token_a TEXT,
            token_b TEXT,
            created_at INTEGER,
            initial_liquidity_usd REAL,
            last_updated INTEGER,
            current_liquidity_usd REAL,
            FOREIGN KEY(token_a) REFERENCES tokens(address),
            FOREIGN KEY(token_b) REFERENCES tokens(address)
          )
        `);

        // Create trades table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            pool_address TEXT,
            token_address TEXT,
            direction TEXT CHECK(direction IN ('BUY', 'SELL')),
            amount REAL,
            price REAL,
            value_usd REAL,
            gas_fee_usd REAL,
            timestamp INTEGER,
            tx_signature TEXT,
            status TEXT,
            FOREIGN KEY(pool_address) REFERENCES liquidity_pools(address),
            FOREIGN KEY(token_address) REFERENCES tokens(address)
          )
        `);

        // Create positions table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS positions (
            id TEXT PRIMARY KEY,
            token_address TEXT,
            entry_price REAL,
            amount REAL,
            open_timestamp INTEGER,
            close_timestamp INTEGER,
            entry_trade_id TEXT,
            exit_trade_id TEXT,
            exit_strategy TEXT,
            status TEXT CHECK(status IN ('OPEN', 'CLOSED')),
            pnl_usd REAL,
            pnl_percent REAL,
            FOREIGN KEY(token_address) REFERENCES tokens(address),
            FOREIGN KEY(entry_trade_id) REFERENCES trades(id),
            FOREIGN KEY(exit_trade_id) REFERENCES trades(id)
          )
        `);

        // Create events table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            timestamp INTEGER,
            data TEXT,
            is_error INTEGER DEFAULT 0
          )
        `, (err: Error | null) => {
          if (err) {
            this.logger.error(`Failed to create tables: ${err.message}`);
            reject(err);
          } else {
            this.initialized = true;
            this.logger.info('Database initialized successfully');
            resolve();
          }
        });
      });
    });
  }

  // Token CRUD operations
  public async addToken(token: Token): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO tokens
        (address, symbol, name, decimals, first_seen, is_verified, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        token.address,
        token.symbol,
        token.name,
        token.decimals,
        token.firstSeen,
        token.isVerified ? 1 : 0,
        JSON.stringify(token.metadata),
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  public async getToken(address: string): Promise<Token | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM tokens WHERE address = ?',
        [address],
        (err: Error | null, row: any) => {
          if (err) {
            reject(err);
          } else if (!row) {
            resolve(null);
          } else {
            resolve({
              address: row.address,
              symbol: row.symbol,
              name: row.name,
              decimals: row.decimals,
              firstSeen: row.first_seen,
              isVerified: !!row.is_verified,
              metadata: JSON.parse(row.metadata || '{}'),
            });
          }
        }
      );
    });
  }

  // LiquidityPool CRUD operations
  public async addLiquidityPool(pool: LiquidityPool): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO liquidity_pools
        (address, dex_name, token_a, token_b, created_at, initial_liquidity_usd, last_updated, current_liquidity_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        pool.address,
        pool.dexName,
        pool.tokenA,
        pool.tokenB,
        pool.createdAt,
        pool.initialLiquidityUsd,
        pool.lastUpdated,
        pool.currentLiquidityUsd,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  public async getLiquidityPool(address: string): Promise<LiquidityPool | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM liquidity_pools WHERE address = ?',
        [address],
        (err: Error | null, row: any) => {
          if (err) {
            reject(err);
          } else if (!row) {
            resolve(null);
          } else {
            resolve({
              address: row.address,
              dexName: row.dex_name,
              tokenA: row.token_a,
              tokenB: row.token_b,
              createdAt: row.created_at,
              initialLiquidityUsd: row.initial_liquidity_usd,
              lastUpdated: row.last_updated,
              currentLiquidityUsd: row.current_liquidity_usd,
            });
          }
        }
      );
    });
  }

  // Trade CRUD operations
  public async addTrade(trade: Trade): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO trades
        (id, pool_address, token_address, direction, amount, price, value_usd, gas_fee_usd, timestamp, tx_signature, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        trade.id,
        trade.poolAddress,
        trade.tokenAddress,
        trade.direction,
        trade.amount,
        trade.price,
        trade.valueUsd,
        trade.gasFeeUsd,
        trade.timestamp,
        trade.txSignature,
        trade.status,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Position CRUD operations
  public async addPosition(position: Position): Promise<void> {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO positions
        (id, token_address, entry_price, amount, open_timestamp, close_timestamp,
         entry_trade_id, exit_trade_id, exit_strategy, status, pnl_usd, pnl_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        position.id,
        position.tokenAddress,
        position.entryPrice,
        position.amount,
        position.openTimestamp,
        position.closeTimestamp || null,
        position.entryTradeId,
        position.exitTradeId || null,
        JSON.stringify(position.exitStrategy),
        position.status,
        position.pnlUsd || null,
        position.pnlPercent || null,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  public async getOpenPositions(): Promise<Position[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM positions WHERE status = ?',
        ['OPEN'],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(err);
          } else {
            resolve(
              rows.map(row => ({
                id: row.id,
                tokenAddress: row.token_address,
                entryPrice: row.entry_price,
                amount: row.amount,
                openTimestamp: row.open_timestamp,
                closeTimestamp: row.close_timestamp,
                entryTradeId: row.entry_trade_id,
                exitTradeId: row.exit_trade_id,
                exitStrategy: JSON.parse(row.exit_strategy),
                status: row.status,
                pnlUsd: row.pnl_usd,
                pnlPercent: row.pnl_percent,
              }))
            );
          }
        }
      );
    });
  }

  public async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err: Error | null) => {
        if (err) {
          this.logger.error(`Error closing database: ${err.message}`);
          reject(err);
        } else {
          this.logger.info('Database closed successfully');
          resolve();
        }
      });
    });
  }
}

export default DatabaseManager;