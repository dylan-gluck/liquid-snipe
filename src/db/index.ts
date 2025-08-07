import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { LiquidityPool, Position, Token, Trade, LogEvent } from '../types';
import { Logger } from '../utils/logger';
import { eventEmitter } from '../utils/event-emitter';

// better-sqlite3 doesn't need verbose mode

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class MigrationError extends DatabaseError {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class DatabaseManager {
  private db: Database.Database;
  private logger: Logger;
  private initialized = false;
  private dbPath: string;
  private backupInterval?: NodeJS.Timeout;
  private dbVersion = 1; // Current schema version

  constructor(
    dbPath: string,
    private options: {
      verbose?: boolean;
      backupIntervalHours?: number;
      maxBackups?: number;
      logToDatabase?: boolean;
    } = {},
  ) {
    this.dbPath = dbPath;
    this.logger = new Logger('DatabaseManager', { verbose: options.verbose || false });

    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.logger.info(`Initializing database at ${dbPath}`);
    try {
      this.db = new Database(dbPath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Failed to open database: ${error.message}`);
      throw new DatabaseError(`Failed to open database at ${dbPath}: ${error.message}`);
    }

    // Set up event listener for database logging if enabled
    if (options.logToDatabase) {
      this.setupLogEventListener();
    }
  }

  private setupLogEventListener(): void {
    // Listen for log events and store them in the database
    eventEmitter.on('log', async (logEvent: LogEvent) => {
      try {
        await this.addLogEvent(logEvent);
      } catch (err) {
        // Don't use logger here to avoid infinite recursion
        console.error('Failed to log to database:', err);
      }
    });
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // First check if the database needs migration by checking schema version
      await this.createVersionTable();
      await this.checkAndMigrateSchema();
      await this.createSchema();

      // Start backup timer if configured
      if (this.options.backupIntervalHours && this.options.backupIntervalHours > 0) {
        this.setupBackupSchedule();
      }

      this.initialized = true;
      this.logger.info('Database initialized successfully');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Database initialization failed: ${error.message}`);
      throw new DatabaseError(`Failed to initialize database: ${error.message}`);
    }
  }

  private async createVersionTable(): Promise<void> {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      // Check if we need to insert the initial version
      const row = this.db.prepare('SELECT version FROM schema_version WHERE id = 1').get();
      if (!row) {
        // Insert initial version
        this.db.prepare('INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)')
          .run(this.dbVersion, Date.now());
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to create version table: ${error.message}`);
    }
  }

  private async checkAndMigrateSchema(): Promise<void> {
    try {
      const row = this.db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
      const currentVersion = row ? row.version : 0;

      if (currentVersion < this.dbVersion) {
        this.logger.info(
          `Migrating database from version ${currentVersion} to ${this.dbVersion}`,
        );

        // Run migrations based on current version
        if (currentVersion < 1) {
          // Migration to version 1 if needed
          // await this.migrateToV1();
        }

        // Update schema version
        await this.updateSchemaVersion(this.dbVersion);
        this.logger.info(`Database migrated to version ${this.dbVersion}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new MigrationError(`Migration failed: ${error.message}`);
    }
  }

  private async updateSchemaVersion(version: number): Promise<void> {
    try {
      this.db.prepare('UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1')
        .run(version, Date.now());
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to update schema version: ${error.message}`);
    }
  }

  private setupBackupSchedule(): void {
    const intervalMs = this.options.backupIntervalHours! * 60 * 60 * 1000;

    this.backupInterval = setInterval(() => {
      this.createBackup().catch(err => {
        this.logger.error(`Backup failed: ${err.message}`);
      });
    }, intervalMs);
  }

  public async createBackup(): Promise<string> {
    if (!this.initialized) {
      throw new DatabaseError('Database not initialized');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(path.dirname(this.dbPath), 'backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const backupPath = path.join(backupDir, `${path.basename(this.dbPath, '.db')}-${timestamp}.db`);

    this.logger.info(`Creating backup at ${backupPath}`);

    return new Promise((resolve, reject) => {
      try {
        // Use better-sqlite3's backup method with destination path
        this.db.backup(backupPath);
        
        this.cleanupOldBackups(backupDir)
          .then(() => {
            resolve(backupPath);
          })
          .catch(cleanupErr => {
            this.logger.warning(
              `Failed to clean up old backups: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
            );
            resolve(backupPath);
          });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reject(new DatabaseError(`Failed to create backup: ${error.message}`));
      }
    });
  }

  private async cleanupOldBackups(backupDir: string): Promise<void> {
    if (!this.options.maxBackups || this.options.maxBackups <= 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      fs.readdir(backupDir, (err, files) => {
        if (err) {
          reject(new Error(`Failed to read backup directory: ${err.message}`));
          return;
        }

        // Filter backup files for this database
        const baseDbName = path.basename(this.dbPath, '.db');
        const backupFiles = files
          .filter(file => file.startsWith(baseDbName) && file.endsWith('.db'))
          .map(file => ({
            file,
            path: path.join(backupDir, file),
            timestamp: fs.statSync(path.join(backupDir, file)).mtime.getTime(),
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Sort by newest first

        // Remove older backups beyond the limit
        if (this.options.maxBackups && backupFiles.length > this.options.maxBackups) {
          const filesToDelete = backupFiles.slice(this.options.maxBackups);

          filesToDelete.forEach(fileInfo => {
            try {
              fs.unlinkSync(fileInfo.path);
              this.logger.debug(`Deleted old backup: ${fileInfo.file}`);
            } catch (unlinkErr) {
              this.logger.warning(
                `Failed to delete old backup ${fileInfo.file}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
              );
            }
          });
        }

        resolve();
      });
    });
  }

  private async createSchema(): Promise<void> {
    try {
      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');

      // Create tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          address TEXT PRIMARY KEY,
          symbol TEXT,
          name TEXT,
          decimals INTEGER,
          first_seen INTEGER NOT NULL,
          is_verified BOOLEAN DEFAULT 0,
          metadata TEXT,
          updated_at INTEGER NOT NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS liquidity_pools (
          address TEXT PRIMARY KEY,
          dex_name TEXT NOT NULL,
          token_a TEXT NOT NULL,
          token_b TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          initial_liquidity_usd REAL NOT NULL,
          last_updated INTEGER NOT NULL,
          current_liquidity_usd REAL NOT NULL,
          FOREIGN KEY(token_a) REFERENCES tokens(address),
          FOREIGN KEY(token_b) REFERENCES tokens(address)
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trades (
          id TEXT PRIMARY KEY,
          pool_address TEXT NOT NULL,
          token_address TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('BUY', 'SELL')),
          amount REAL NOT NULL,
          price REAL NOT NULL,
          value_usd REAL NOT NULL,
          gas_fee_usd REAL,
          timestamp INTEGER NOT NULL,
          tx_signature TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'CONFIRMED', 'FAILED')),
          FOREIGN KEY(pool_address) REFERENCES liquidity_pools(address),
          FOREIGN KEY(token_address) REFERENCES tokens(address)
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
          id TEXT PRIMARY KEY,
          token_address TEXT NOT NULL,
          entry_price REAL NOT NULL,
          amount REAL NOT NULL,
          open_timestamp INTEGER NOT NULL,
          close_timestamp INTEGER,
          entry_trade_id TEXT NOT NULL,
          exit_trade_id TEXT,
          exit_strategy TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLOSED')),
          pnl_usd REAL,
          pnl_percent REAL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(token_address) REFERENCES tokens(address),
          FOREIGN KEY(entry_trade_id) REFERENCES trades(id),
          FOREIGN KEY(exit_trade_id) REFERENCES trades(id)
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error', 'success', 'debug')),
          message TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          data TEXT,
          context TEXT
        )
      `);

      // Create indexes for better performance
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_liquidity_pools_tokens ON liquidity_pools(token_a, token_b)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to create schema: ${error.message}`);
    }
  }

  // Utility method to run queries with proper error handling
  private async run(sql: string, params: any[] = []): Promise<Database.RunResult> {
    try {
      return this.db.prepare(sql).run(...params);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`SQL error (${sql}): ${error.message}`);
    }
  }

  // Utility method for SELECT queries that return a single row
  private async get<T>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const row = this.db.prepare(sql).get(...params) as T | undefined;
      return row || null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`SQL error (${sql}): ${error.message}`);
    }
  }

  // Utility method for SELECT queries that return multiple rows
  private async all<T>(sql: string, params: any[] = []): Promise<T[]> {
    try {
      const rows = this.db.prepare(sql).all(...params) as T[];
      return rows || [];
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`SQL error (${sql}): ${error.message}`);
    }
  }

  // Utility method to execute statements in a transaction
  public async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }

    const transaction = this.db.transaction(callback);
    try {
      return await transaction();
    } catch (err) {
      throw err instanceof Error ? err : new DatabaseError(String(err));
    }
  }

  /************************************
   * Token Operations
   ************************************/

  // Add or update token
  public async upsertToken(token: Token): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const now = Date.now();
    const existingToken = await this.getToken(token.address);

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tokens
        (address, symbol, name, decimals, first_seen, is_verified, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        token.address,
        token.symbol,
        token.name,
        token.decimals,
        existingToken ? existingToken.firstSeen : token.firstSeen || now,
        token.isVerified ? 1 : 0,
        JSON.stringify(token.metadata || {}),
        now,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to upsert token: ${error.message}`);
    }
  }

  // Add token (only if it doesn't exist)
  public async addToken(token: Token): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const now = Date.now();
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO tokens
        (address, symbol, name, decimals, first_seen, is_verified, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        token.address,
        token.symbol,
        token.name,
        token.decimals,
        token.firstSeen || now,
        token.isVerified ? 1 : 0,
        JSON.stringify(token.metadata || {}),
        now,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to add token: ${error.message}`);
    }
  }

  // Get token by address
  public async getToken(address: string): Promise<Token | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const row = this.db.prepare('SELECT * FROM tokens WHERE address = ?').get(address) as any;
      if (!row) {
        return null;
      }
      return {
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        firstSeen: row.first_seen,
        isVerified: !!row.is_verified,
        metadata: JSON.parse(row.metadata || '{}'),
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get token: ${error.message}`);
    }
  }

  // Get all tokens
  public async getTokens(): Promise<Token[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM tokens ORDER BY first_seen DESC').all() as any[];
      return rows.map(row => ({
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        firstSeen: row.first_seen,
        isVerified: !!row.is_verified,
        metadata: JSON.parse(row.metadata || '{}'),
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get tokens: ${error.message}`);
    }
  }

  // Update token verification status
  public async updateTokenVerification(address: string, isVerified: boolean): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result = this.db.prepare('UPDATE tokens SET is_verified = ?, updated_at = ? WHERE address = ?')
        .run(isVerified ? 1 : 0, Date.now(), address);
      return result.changes > 0;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to update token verification: ${error.message}`);
    }
  }

  /************************************
   * Liquidity Pool Operations
   ************************************/

  // Add or update liquidity pool
  public async upsertLiquidityPool(pool: LiquidityPool): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
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
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to upsert liquidity pool: ${error.message}`);
    }
  }

  // Add liquidity pool
  public async addLiquidityPool(pool: LiquidityPool): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Insert both tokens first to maintain referential integrity
    try {
      // Check if tokens exist, and if not, create placeholder records
      const tokenA = await this.getToken(pool.tokenA);
      if (!tokenA) {
        await this.addToken({
          address: pool.tokenA,
          firstSeen: pool.createdAt,
          isVerified: false,
          metadata: {},
        });
      }

      const tokenB = await this.getToken(pool.tokenB);
      if (!tokenB) {
        await this.addToken({
          address: pool.tokenB,
          firstSeen: pool.createdAt,
          isVerified: false,
          metadata: {},
        });
      }
    } catch (err) {
      this.logger.warning(
        `Failed to ensure tokens exist for pool ${pool.address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO liquidity_pools
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
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to add liquidity pool: ${error.message}`);
    }
  }

  // Get liquidity pool by address
  public async getLiquidityPool(address: string): Promise<LiquidityPool | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const row = this.db.prepare('SELECT * FROM liquidity_pools WHERE address = ?').get(address) as any;
      if (!row) {
        return null;
      }
      return {
        address: row.address,
        dexName: row.dex_name,
        tokenA: row.token_a,
        tokenB: row.token_b,
        createdAt: row.created_at,
        initialLiquidityUsd: row.initial_liquidity_usd,
        lastUpdated: row.last_updated,
        currentLiquidityUsd: row.current_liquidity_usd,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get liquidity pool: ${error.message}`);
    }
  }

  // Get all liquidity pools
  public async getLiquidityPools(): Promise<LiquidityPool[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM liquidity_pools ORDER BY created_at DESC').all() as any[];
      return rows.map(row => ({
        address: row.address,
        dexName: row.dex_name,
        tokenA: row.token_a,
        tokenB: row.token_b,
        createdAt: row.created_at,
        initialLiquidityUsd: row.initial_liquidity_usd,
        lastUpdated: row.last_updated,
        currentLiquidityUsd: row.current_liquidity_usd,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get liquidity pools: ${error.message}`);
    }
  }

  // Get pools by token address
  public async getPoolsByToken(tokenAddress: string): Promise<LiquidityPool[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM liquidity_pools WHERE token_a = ? OR token_b = ? ORDER BY created_at DESC')
        .all(tokenAddress, tokenAddress) as any[];
      return rows.map(row => ({
        address: row.address,
        dexName: row.dex_name,
        tokenA: row.token_a,
        tokenB: row.token_b,
        createdAt: row.created_at,
        initialLiquidityUsd: row.initial_liquidity_usd,
        lastUpdated: row.last_updated,
        currentLiquidityUsd: row.current_liquidity_usd,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get pools for token: ${error.message}`);
    }
  }

  // Update liquidity pool current values
  public async updatePoolLiquidity(address: string, currentLiquidity: number): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result = this.db.prepare('UPDATE liquidity_pools SET current_liquidity_usd = ?, last_updated = ? WHERE address = ?')
        .run(currentLiquidity, Date.now(), address);
      return result.changes > 0;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to update pool liquidity: ${error.message}`);
    }
  }

  /************************************
   * Trade Operations
   ************************************/

  // Add a new trade
  public async addTrade(trade: Trade): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Ensure the trade has an ID
    const tradeWithId = {
      ...trade,
      id: trade.id || uuidv4(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO trades
        (id, pool_address, token_address, direction, amount, price, value_usd, gas_fee_usd, timestamp, tx_signature, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        tradeWithId.id,
        tradeWithId.poolAddress,
        tradeWithId.tokenAddress,
        tradeWithId.direction,
        tradeWithId.amount,
        tradeWithId.price,
        tradeWithId.valueUsd,
        tradeWithId.gasFeeUsd,
        tradeWithId.timestamp,
        tradeWithId.txSignature,
        tradeWithId.status,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to add trade: ${error.message}`);
    }
  }

  // Get trade by ID
  public async getTrade(id: string): Promise<Trade | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as any;
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        poolAddress: row.pool_address,
        tokenAddress: row.token_address,
        direction: row.direction as 'BUY' | 'SELL',
        amount: row.amount,
        price: row.price,
        valueUsd: row.value_usd,
        gasFeeUsd: row.gas_fee_usd,
        timestamp: row.timestamp,
        txSignature: row.tx_signature,
        status: row.status as 'PENDING' | 'CONFIRMED' | 'FAILED',
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get trade: ${error.message}`);
    }
  }

  // Get trades for a token
  public async getTradesByToken(tokenAddress: string): Promise<Trade[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM trades WHERE token_address = ? ORDER BY timestamp DESC')
        .all(tokenAddress) as any[];
      return rows.map(row => ({
        id: row.id,
        poolAddress: row.pool_address,
        tokenAddress: row.token_address,
        direction: row.direction as 'BUY' | 'SELL',
        amount: row.amount,
        price: row.price,
        valueUsd: row.value_usd,
        gasFeeUsd: row.gas_fee_usd,
        timestamp: row.timestamp,
        txSignature: row.tx_signature,
        status: row.status as 'PENDING' | 'CONFIRMED' | 'FAILED',
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get trades for token: ${error.message}`);
    }
  }

  // Update trade status
  public async updateTradeStatus(
    id: string,
    status: 'PENDING' | 'CONFIRMED' | 'FAILED',
  ): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result = this.db.prepare('UPDATE trades SET status = ? WHERE id = ?')
        .run(status, id);
      return result.changes > 0;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to update trade status: ${error.message}`);
    }
  }

  /************************************
   * Position Operations
   ************************************/

  // Add a new position
  public async addPosition(position: Position): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Ensure the position has an ID
    const positionWithId = {
      ...position,
      id: position.id || uuidv4(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO positions
        (id, token_address, entry_price, amount, open_timestamp, close_timestamp,
         entry_trade_id, exit_trade_id, exit_strategy, status, pnl_usd, pnl_percent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        positionWithId.id,
        positionWithId.tokenAddress,
        positionWithId.entryPrice,
        positionWithId.amount,
        positionWithId.openTimestamp,
        positionWithId.closeTimestamp || null,
        positionWithId.entryTradeId,
        positionWithId.exitTradeId || null,
        JSON.stringify(positionWithId.exitStrategy),
        positionWithId.status,
        positionWithId.pnlUsd || null,
        positionWithId.pnlPercent || null,
        Date.now(),
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to add position: ${error.message}`);
    }
  }

  // Get position by ID
  public async getPosition(id: string): Promise<Position | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as any;
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        tokenAddress: row.token_address,
        entryPrice: row.entry_price,
        amount: row.amount,
        openTimestamp: row.open_timestamp,
        closeTimestamp: row.close_timestamp,
        entryTradeId: row.entry_trade_id,
        exitTradeId: row.exit_trade_id,
        exitStrategy: JSON.parse(row.exit_strategy),
        status: row.status as 'OPEN' | 'CLOSED',
        pnlUsd: row.pnl_usd,
        pnlPercent: row.pnl_percent,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get position: ${error.message}`);
    }
  }

  // Get all open positions
  public async getOpenPositions(): Promise<Position[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM positions WHERE status = ? ORDER BY open_timestamp DESC')
        .all('OPEN') as any[];
      return rows.map(row => ({
        id: row.id,
        tokenAddress: row.token_address,
        entryPrice: row.entry_price,
        amount: row.amount,
        openTimestamp: row.open_timestamp,
        closeTimestamp: row.close_timestamp,
        entryTradeId: row.entry_trade_id,
        exitTradeId: row.exit_trade_id,
        exitStrategy: JSON.parse(row.exit_strategy),
        status: row.status as 'OPEN' | 'CLOSED',
        pnlUsd: row.pnl_usd,
        pnlPercent: row.pnl_percent,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get open positions: ${error.message}`);
    }
  }

  // Get all closed positions
  public async getClosedPositions(): Promise<Position[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM positions WHERE status = ? ORDER BY close_timestamp DESC')
        .all('CLOSED') as any[];
      return rows.map(row => ({
        id: row.id,
        tokenAddress: row.token_address,
        entryPrice: row.entry_price,
        amount: row.amount,
        openTimestamp: row.open_timestamp,
        closeTimestamp: row.close_timestamp,
        entryTradeId: row.entry_trade_id,
        exitTradeId: row.exit_trade_id,
        exitStrategy: JSON.parse(row.exit_strategy),
        status: row.status as 'OPEN' | 'CLOSED',
        pnlUsd: row.pnl_usd,
        pnlPercent: row.pnl_percent,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get closed positions: ${error.message}`);
    }
  }

  // Close a position
  public async closePosition(
    id: string,
    exitTradeId: string,
    closeTimestamp: number,
    pnlUsd: number,
    pnlPercent: number,
  ): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result = this.db.prepare(
        `UPDATE positions SET 
         status = 'CLOSED', 
         exit_trade_id = ?, 
         close_timestamp = ?, 
         pnl_usd = ?, 
         pnl_percent = ?,
         updated_at = ?
         WHERE id = ? AND status = 'OPEN'`
      ).run(exitTradeId, closeTimestamp, pnlUsd, pnlPercent, Date.now(), id);
      return result.changes > 0;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to close position: ${error.message}`);
    }
  }

  /************************************
   * Event Logging Operations
   ************************************/

  // Add a log event to the database
  public async addLogEvent(event: LogEvent): Promise<void> {
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch (err) {
        // If we can't initialize, don't try to log to the database
        console.error('Could not initialize database for logging:', err);
        return;
      }
    }

    try {
      const contextMatch = event.message.match(/^\[(.*?)\]/);
      const context = contextMatch ? contextMatch[1] : null;

      const stmt = this.db.prepare(`
        INSERT INTO events
        (level, message, timestamp, data, context)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        event.level,
        event.message,
        event.timestamp,
        event.data ? JSON.stringify(event.data) : null,
        context,
      );
    } catch (err) {
      console.error(`Failed to add log event: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  // Get recent log events
  public async getRecentLogEvents(limit = 100, level?: LogEvent['level']): Promise<LogEvent[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const query = level
      ? 'SELECT * FROM events WHERE level = ? ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT * FROM events ORDER BY timestamp DESC LIMIT ?';

    const params = level ? [level, limit] : [limit];

    try {
      const rows = this.db.prepare(query).all(...params) as any[];
      return rows.map(row => ({
        level: row.level as LogEvent['level'],
        message: row.message,
        timestamp: row.timestamp,
        data: row.data ? JSON.parse(row.data) : undefined,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get log events: ${error.message}`);
    }
  }

  // Prune old log events
  public async pruneOldLogEvents(olderThanDays: number): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    const cutoffTimestamp = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    try {
      const result = this.db.prepare('DELETE FROM events WHERE timestamp < ?')
        .run(cutoffTimestamp);
      return result.changes;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to prune old log events: ${error.message}`);
    }
  }

  /************************************
   * Database Management
   ************************************/

  // Close the database connection
  public async close(): Promise<void> {
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = undefined;
    }

    try {
      this.db.close();
      this.logger.info('Database closed successfully');
      this.initialized = false;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Error closing database: ${error.message}`);
      throw new DatabaseError(`Failed to close database: ${error.message}`);
    }
  }

  // Get database stats
  public async getStats(): Promise<{
    tokenCount: number;
    poolCount: number;
    tradeCount: number;
    openPositionCount: number;
    closedPositionCount: number;
    dbSizeBytes: number;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const tokenCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM tokens');
      const poolCount = await this.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM liquidity_pools',
      );
      const tradeCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM trades');
      const openPositionCount = await this.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM positions WHERE status = ?',
        ['OPEN'],
      );
      const closedPositionCount = await this.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM positions WHERE status = ?',
        ['CLOSED'],
      );

      // Get the database file size
      const stats = fs.statSync(this.dbPath);

      return {
        tokenCount: tokenCount?.count || 0,
        poolCount: poolCount?.count || 0,
        tradeCount: tradeCount?.count || 0,
        openPositionCount: openPositionCount?.count || 0,
        closedPositionCount: closedPositionCount?.count || 0,
        dbSizeBytes: stats.size,
      };
    } catch (err) {
      throw new DatabaseError(
        `Failed to get database stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Vacuum the database to optimize storage
  public async vacuum(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      this.db.exec('VACUUM');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to vacuum database: ${error.message}`);
    }
  }

  // Get all positions
  public async getAllPositions(): Promise<Position[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM positions ORDER BY open_timestamp DESC')
        .all() as any[];
      return rows.map(row => ({
        id: row.id,
        tokenAddress: row.token_address,
        entryPrice: row.entry_price,
        amount: row.amount,
        openTimestamp: row.open_timestamp,
        closeTimestamp: row.close_timestamp,
        entryTradeId: row.entry_trade_id,
        exitTradeId: row.exit_trade_id,
        exitStrategy: JSON.parse(row.exit_strategy),
        status: row.status as 'OPEN' | 'CLOSED',
        pnlUsd: row.pnl_usd,
        pnlPercent: row.pnl_percent,
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get all positions: ${error.message}`);
    }
  }

  // Get all trades
  public async getAllTrades(): Promise<Trade[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM trades ORDER BY timestamp DESC')
        .all() as any[];
      return rows.map(row => ({
        id: row.id,
        poolAddress: row.pool_address,
        tokenAddress: row.token_address,
        direction: row.direction as 'BUY' | 'SELL',
        amount: row.amount,
        price: row.price,
        valueUsd: row.value_usd,
        gasFeeUsd: row.gas_fee_usd,
        timestamp: row.timestamp,
        txSignature: row.tx_signature,
        status: row.status as 'PENDING' | 'CONFIRMED' | 'FAILED',
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get all trades: ${error.message}`);
    }
  }

  // Get all pools
  public async getAllPools(): Promise<LiquidityPool[]> {
    return this.getLiquidityPools();
  }

  // Get recent trades
  public async getRecentTrades(limit = 50): Promise<Trade[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const rows = this.db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?')
        .all(limit) as any[];
      return rows.map(row => ({
        id: row.id,
        poolAddress: row.pool_address,
        tokenAddress: row.token_address,
        direction: row.direction as 'BUY' | 'SELL',
        amount: row.amount,
        price: row.price,
        valueUsd: row.value_usd,
        gasFeeUsd: row.gas_fee_usd,
        timestamp: row.timestamp,
        txSignature: row.tx_signature,
        status: row.status as 'PENDING' | 'CONFIRMED' | 'FAILED',
      }));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`Failed to get recent trades: ${error.message}`);
    }
  }

  // Clean up old events
  public async cleanupOldEvents(olderThanDays: number): Promise<number> {
    return this.pruneOldLogEvents(olderThanDays);
  }
}

// Export model classes
export * from './models';

// Export database manager
export default DatabaseManager;
