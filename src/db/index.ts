import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { LiquidityPool, Position, Token, Trade, LogEvent } from '../types';
import { Logger } from '../utils/logger';
import { eventEmitter } from '../utils/event-emitter';

// Enable verbose mode for debugging if needed
// sqlite3.verbose();

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
  private db: sqlite3.Database;
  private logger: Logger;
  private initialized = false;
  private dbPath: string;
  private backupInterval?: NodeJS.Timeout;
  private dbVersion = 1; // Current schema version

  constructor(dbPath: string, private options: {
    verbose?: boolean;
    backupIntervalHours?: number;
    maxBackups?: number;
    logToDatabase?: boolean;
  } = {}) {
    this.dbPath = dbPath;
    this.logger = new Logger('DatabaseManager', options.verbose || false);
    
    // Ensure the directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.logger.info(`Initializing database at ${dbPath}`);
    this.db = new sqlite3.Database(dbPath, (err: Error | null) => {
      if (err) {
        this.logger.error(`Failed to open database: ${err.message}`);
        throw new DatabaseError(`Failed to open database at ${dbPath}: ${err.message}`);
      }
    });

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
    return new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `, (err: Error | null) => {
        if (err) {
          reject(new DatabaseError(`Failed to create version table: ${err.message}`));
        } else {
          // Check if we need to insert the initial version
          this.db.get('SELECT version FROM schema_version WHERE id = 1', [], (err, row) => {
            if (err) {
              reject(new DatabaseError(`Failed to check schema version: ${err.message}`));
            } else if (!row) {
              // Insert initial version
              this.db.run(
                'INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)',
                [this.dbVersion, Date.now()],
                (err) => {
                  if (err) {
                    reject(new DatabaseError(`Failed to insert initial schema version: ${err.message}`));
                  } else {
                    resolve();
                  }
                }
              );
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  private async checkAndMigrateSchema(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT version FROM schema_version WHERE id = 1', [], async (err, row: { version: number } | undefined) => {
        if (err) {
          reject(new DatabaseError(`Failed to check schema version: ${err.message}`));
          return;
        }
        
        const currentVersion = row ? row.version : 0;
        
        if (currentVersion < this.dbVersion) {
          try {
            this.logger.info(`Migrating database from version ${currentVersion} to ${this.dbVersion}`);
            
            // Run migrations based on current version
            if (currentVersion < 1) {
              // Migration to version 1 if needed
              // await this.migrateToV1();
            }
            
            // Update schema version
            await this.updateSchemaVersion(this.dbVersion);
            this.logger.info(`Database migrated to version ${this.dbVersion}`);
            resolve();
          } catch (migrateErr) {
            reject(new MigrationError(`Migration failed: ${migrateErr instanceof Error ? migrateErr.message : String(migrateErr)}`));
          }
        } else {
          resolve();
        }
      });
    });
  }

  private async updateSchemaVersion(version: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1',
        [version, Date.now()],
        (err) => {
          if (err) {
            reject(new DatabaseError(`Failed to update schema version: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
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
      // Create a new database for the backup
      const backupDb = new sqlite3.Database(backupPath, (err) => {
        if (err) {
          reject(new DatabaseError(`Failed to create backup database: ${err.message}`));
          return;
        }
        
        // Use a more reliable method - export all tables
        this.db.serialize(() => {
          // First try with direct backup command that works in some environments
          this.db.run(`.backup ${backupPath}`, (err) => {
            if (err) {
              // If that fails, use a manual approach - attach and copy
              this.db.run(`ATTACH DATABASE '${backupPath}' AS backup`, (attachErr) => {
                if (attachErr) {
                  backupDb.close();
                  reject(new DatabaseError(`Failed to attach backup database: ${attachErr.message}`));
                  return;
                }
                
                // Get all tables
                this.db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (tablesErr, tables: Array<{name: string}>) => {
                  if (tablesErr) {
                    this.db.run('DETACH DATABASE backup');
                    backupDb.close();
                    reject(new DatabaseError(`Failed to get tables: ${tablesErr.message}`));
                    return;
                  }
                  
                  // Copy the schema and data for each table
                  const promises = tables.map(table => {
                    return new Promise<void>((copyResolve, copyReject) => {
                      const tableName = table.name;
                      if (tableName === 'sqlite_sequence') {
                        copyResolve();
                        return;
                      }
                      
                      this.db.run(`CREATE TABLE backup.${tableName} AS SELECT * FROM main.${tableName}`, (copyErr) => {
                        if (copyErr) {
                          copyReject(copyErr);
                        } else {
                          copyResolve();
                        }
                      });
                    });
                  });
                  
                  Promise.all(promises)
                    .then(() => {
                      this.db.run('DETACH DATABASE backup', (detachErr) => {
                        backupDb.close();
                        
                        if (detachErr) {
                          reject(new DatabaseError(`Failed to detach backup database: ${detachErr.message}`));
                        } else {
                          this.cleanupOldBackups(backupDir).then(() => {
                            resolve(backupPath);
                          }).catch(cleanupErr => {
                            this.logger.warning(`Failed to clean up old backups: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                            resolve(backupPath);
                          });
                        }
                      });
                    })
                    .catch(copyErr => {
                      this.db.run('DETACH DATABASE backup');
                      backupDb.close();
                      reject(new DatabaseError(`Failed to copy data: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`));
                    });
                });
              });
            } else {
              // Direct backup succeeded
              backupDb.close();
              this.cleanupOldBackups(backupDir).then(() => {
                resolve(backupPath);
              }).catch(cleanupErr => {
                this.logger.warning(`Failed to clean up old backups: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                resolve(backupPath);
              });
            }
          });
        });
      });
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
            timestamp: fs.statSync(path.join(backupDir, file)).mtime.getTime()
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
              this.logger.warning(`Failed to delete old backup ${fileInfo.file}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`);
            }
          });
        }
        
        resolve();
      });
    });
  }

  private async createSchema(): Promise<void> {
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
            first_seen INTEGER NOT NULL,
            is_verified BOOLEAN DEFAULT 0,
            metadata TEXT,
            updated_at INTEGER NOT NULL
          )
        `);

        // Create liquidity_pools table
        this.db.run(`
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

        // Create trades table
        this.db.run(`
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

        // Create positions table
        this.db.run(`
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

        // Create events table
        this.db.run(`
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
        this.db.run('CREATE INDEX IF NOT EXISTS idx_liquidity_pools_tokens ON liquidity_pools(token_a, token_b)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)');

        // Check for any errors
        this.db.get('SELECT 1', [], (err) => {
          if (err) {
            reject(new DatabaseError(`Failed to create schema: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    });
  }

  // Utility method to run queries with proper error handling
  private async run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err: Error | null) {
        if (err) {
          reject(new DatabaseError(`SQL error (${sql}): ${err.message}`));
        } else {
          resolve(this);
        }
      });
    });
  }

  // Utility method for SELECT queries that return a single row
  private async get<T>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err: Error | null, row: T) => {
        if (err) {
          reject(new DatabaseError(`SQL error (${sql}): ${err.message}`));
        } else {
          resolve(row || null);
        }
      });
    });
  }

  // Utility method for SELECT queries that return multiple rows
  private async all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err: Error | null, rows: T[]) => {
        if (err) {
          reject(new DatabaseError(`SQL error (${sql}): ${err.message}`));
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  // Utility method to execute statements in a transaction
  public async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run('BEGIN TRANSACTION', async (err) => {
        if (err) {
          reject(new DatabaseError(`Failed to begin transaction: ${err.message}`));
          return;
        }

        try {
          const result = await callback();
          
          this.db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              this.db.run('ROLLBACK', () => {
                reject(new DatabaseError(`Failed to commit transaction: ${commitErr.message}`));
              });
            } else {
              resolve(result);
            }
          });
        } catch (execErr) {
          this.db.run('ROLLBACK', () => {
            reject(execErr instanceof Error ? execErr : new DatabaseError(String(execErr)));
          });
        }
      });
    });
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
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tokens
      (address, symbol, name, decimals, first_seen, is_verified, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
      stmt.run(
        token.address,
        token.symbol,
        token.name,
        token.decimals,
        existingToken ? existingToken.firstSeen : token.firstSeen || now,
        token.isVerified ? 1 : 0,
        JSON.stringify(token.metadata || {}),
        now,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(new DatabaseError(`Failed to upsert token: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Add token (only if it doesn't exist)
  public async addToken(token: Token): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO tokens
      (address, symbol, name, decimals, first_seen, is_verified, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
      stmt.run(
        token.address,
        token.symbol,
        token.name,
        token.decimals,
        token.firstSeen || now,
        token.isVerified ? 1 : 0,
        JSON.stringify(token.metadata || {}),
        now,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(new DatabaseError(`Failed to add token: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Get token by address
  public async getToken(address: string): Promise<Token | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM tokens WHERE address = ?',
        [address],
        (err: Error | null, row: any) => {
          if (err) {
            reject(new DatabaseError(`Failed to get token: ${err.message}`));
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

  // Get all tokens
  public async getTokens(): Promise<Token[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM tokens ORDER BY first_seen DESC',
        [],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get tokens: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
              address: row.address,
              symbol: row.symbol,
              name: row.name,
              decimals: row.decimals,
              firstSeen: row.first_seen,
              isVerified: !!row.is_verified,
              metadata: JSON.parse(row.metadata || '{}'),
            })));
          }
        }
      );
    });
  }

  // Update token verification status
  public async updateTokenVerification(address: string, isVerified: boolean): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE tokens SET is_verified = ?, updated_at = ? WHERE address = ?',
        [isVerified ? 1 : 0, Date.now(), address],
        function(err: Error | null) {
          if (err) {
            reject(new DatabaseError(`Failed to update token verification: ${err.message}`));
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  /************************************
   * Liquidity Pool Operations
   ************************************/
  
  // Add or update liquidity pool
  public async upsertLiquidityPool(pool: LiquidityPool): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO liquidity_pools
      (address, dex_name, token_a, token_b, created_at, initial_liquidity_usd, last_updated, current_liquidity_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
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
            reject(new DatabaseError(`Failed to upsert liquidity pool: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
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
      this.logger.warning(`Failed to ensure tokens exist for pool ${pool.address}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO liquidity_pools
      (address, dex_name, token_a, token_b, created_at, initial_liquidity_usd, last_updated, current_liquidity_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
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
            reject(new DatabaseError(`Failed to add liquidity pool: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Get liquidity pool by address
  public async getLiquidityPool(address: string): Promise<LiquidityPool | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM liquidity_pools WHERE address = ?',
        [address],
        (err: Error | null, row: any) => {
          if (err) {
            reject(new DatabaseError(`Failed to get liquidity pool: ${err.message}`));
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

  // Get all liquidity pools
  public async getLiquidityPools(): Promise<LiquidityPool[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM liquidity_pools ORDER BY created_at DESC',
        [],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get liquidity pools: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
              address: row.address,
              dexName: row.dex_name,
              tokenA: row.token_a,
              tokenB: row.token_b,
              createdAt: row.created_at,
              initialLiquidityUsd: row.initial_liquidity_usd,
              lastUpdated: row.last_updated,
              currentLiquidityUsd: row.current_liquidity_usd,
            })));
          }
        }
      );
    });
  }

  // Get pools by token address
  public async getPoolsByToken(tokenAddress: string): Promise<LiquidityPool[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM liquidity_pools WHERE token_a = ? OR token_b = ? ORDER BY created_at DESC',
        [tokenAddress, tokenAddress],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get pools for token: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
              address: row.address,
              dexName: row.dex_name,
              tokenA: row.token_a,
              tokenB: row.token_b,
              createdAt: row.created_at,
              initialLiquidityUsd: row.initial_liquidity_usd,
              lastUpdated: row.last_updated,
              currentLiquidityUsd: row.current_liquidity_usd,
            })));
          }
        }
      );
    });
  }

  // Update liquidity pool current values
  public async updatePoolLiquidity(address: string, currentLiquidity: number): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE liquidity_pools SET current_liquidity_usd = ?, last_updated = ? WHERE address = ?',
        [currentLiquidity, Date.now(), address],
        function(err: Error | null) {
          if (err) {
            reject(new DatabaseError(`Failed to update pool liquidity: ${err.message}`));
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
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
      id: trade.id || uuidv4()
    };

    const stmt = this.db.prepare(`
      INSERT INTO trades
      (id, pool_address, token_address, direction, amount, price, value_usd, gas_fee_usd, timestamp, tx_signature, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
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
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(new DatabaseError(`Failed to add trade: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Get trade by ID
  public async getTrade(id: string): Promise<Trade | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM trades WHERE id = ?',
        [id],
        (err: Error | null, row: any) => {
          if (err) {
            reject(new DatabaseError(`Failed to get trade: ${err.message}`));
          } else if (!row) {
            resolve(null);
          } else {
            resolve({
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
            });
          }
        }
      );
    });
  }

  // Get trades for a token
  public async getTradesByToken(tokenAddress: string): Promise<Trade[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM trades WHERE token_address = ? ORDER BY timestamp DESC',
        [tokenAddress],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get trades for token: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
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
            })));
          }
        }
      );
    });
  }

  // Update trade status
  public async updateTradeStatus(id: string, status: 'PENDING' | 'CONFIRMED' | 'FAILED'): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE trades SET status = ? WHERE id = ?',
        [status, id],
        function(err: Error | null) {
          if (err) {
            reject(new DatabaseError(`Failed to update trade status: ${err.message}`));
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
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
      id: position.id || uuidv4()
    };

    const stmt = this.db.prepare(`
      INSERT INTO positions
      (id, token_address, entry_price, amount, open_timestamp, close_timestamp,
       entry_trade_id, exit_trade_id, exit_strategy, status, pnl_usd, pnl_percent, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
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
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            reject(new DatabaseError(`Failed to add position: ${err.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Get position by ID
  public async getPosition(id: string): Promise<Position | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM positions WHERE id = ?',
        [id],
        (err: Error | null, row: any) => {
          if (err) {
            reject(new DatabaseError(`Failed to get position: ${err.message}`));
          } else if (!row) {
            resolve(null);
          } else {
            resolve({
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
            });
          }
        }
      );
    });
  }

  // Get all open positions
  public async getOpenPositions(): Promise<Position[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM positions WHERE status = ? ORDER BY open_timestamp DESC',
        ['OPEN'],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get open positions: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
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
            })));
          }
        }
      );
    });
  }

  // Get all closed positions
  public async getClosedPositions(): Promise<Position[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM positions WHERE status = ? ORDER BY close_timestamp DESC',
        ['CLOSED'],
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get closed positions: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
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
            })));
          }
        }
      );
    });
  }

  // Close a position
  public async closePosition(id: string, exitTradeId: string, closeTimestamp: number, pnlUsd: number, pnlPercent: number): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE positions SET 
         status = 'CLOSED', 
         exit_trade_id = ?, 
         close_timestamp = ?, 
         pnl_usd = ?, 
         pnl_percent = ?,
         updated_at = ?
         WHERE id = ? AND status = 'OPEN'`,
        [exitTradeId, closeTimestamp, pnlUsd, pnlPercent, Date.now(), id],
        function(err: Error | null) {
          if (err) {
            reject(new DatabaseError(`Failed to close position: ${err.message}`));
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
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

    const stmt = this.db.prepare(`
      INSERT INTO events
      (level, message, timestamp, data, context)
      VALUES (?, ?, ?, ?, ?)
    `);

    return new Promise((resolve, reject) => {
      const contextMatch = event.message.match(/^\[(.*?)\]/);
      const context = contextMatch ? contextMatch[1] : null;
      
      stmt.run(
        event.level,
        event.message,
        event.timestamp,
        event.data ? JSON.stringify(event.data) : null,
        context,
        function(err: Error | null) {
          stmt.finalize();
          if (err) {
            console.error(`Failed to add log event: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
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

    return new Promise((resolve, reject) => {
      this.db.all(
        query,
        params,
        (err: Error | null, rows: any[]) => {
          if (err) {
            reject(new DatabaseError(`Failed to get log events: ${err.message}`));
          } else {
            resolve(rows.map(row => ({
              level: row.level as LogEvent['level'],
              message: row.message,
              timestamp: row.timestamp,
              data: row.data ? JSON.parse(row.data) : undefined,
            })));
          }
        }
      );
    });
  }

  // Prune old log events
  public async pruneOldLogEvents(olderThanDays: number): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    const cutoffTimestamp = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM events WHERE timestamp < ?',
        [cutoffTimestamp],
        function(err: Error | null) {
          if (err) {
            reject(new DatabaseError(`Failed to prune old log events: ${err.message}`));
          } else {
            resolve(this.changes);
          }
        }
      );
    });
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

    return new Promise((resolve, reject) => {
      this.db.close((err: Error | null) => {
        if (err) {
          this.logger.error(`Error closing database: ${err.message}`);
          reject(new DatabaseError(`Failed to close database: ${err.message}`));
        } else {
          this.logger.info('Database closed successfully');
          this.initialized = false;
          resolve();
        }
      });
    });
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
      const poolCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM liquidity_pools');
      const tradeCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM trades');
      const openPositionCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM positions WHERE status = ?', ['OPEN']);
      const closedPositionCount = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM positions WHERE status = ?', ['CLOSED']);
      
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
      throw new DatabaseError(`Failed to get database stats: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Vacuum the database to optimize storage
  public async vacuum(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.db.run('VACUUM', (err: Error | null) => {
        if (err) {
          reject(new DatabaseError(`Failed to vacuum database: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }
}

// Export model classes
export * from './models';

// Export database manager and errors
export { DatabaseManager, DatabaseError, MigrationError };
export default DatabaseManager;