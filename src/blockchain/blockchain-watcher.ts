import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  LogsCallback,
  Commitment,
  ParsedInnerInstruction,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  Finality,
} from '@solana/web3.js';
import { EventEmitter } from 'events';
import { ConnectionManager } from './connection-manager';
import { DexConfig, NewPoolEvent } from '../types';
import { createDexParser, type PoolCreationInfo } from './dex-parsers';

export interface WatcherStatus {
  isActive: boolean;
  subscriptions: number[];
  eventsProcessed: number;
  errors: number;
  lastEventTime?: number;
}

export interface PoolInfo {
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  initialLiquidity?: number;
  creator?: string;
  baseToken?: string;
  quoteToken?: string;
  programId?: string;
  instructionType?: string;
}

/**
 * BlockchainWatcher monitors Solana blockchain for new liquidity pool creation events
 * Subscribes to program logs for configured DEXes and parses pool creation transactions
 */
export class BlockchainWatcher extends EventEmitter {
  private connectionManager: ConnectionManager;
  private dexConfigs: DexConfig[];
  private subscriptions: number[] = [];
  private status: WatcherStatus;
  private commitment: Finality = 'finalized';
  private isShuttingDown = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(
    connectionManager: ConnectionManager,
    dexConfigs: DexConfig[],
    commitment: Finality = 'finalized',
  ) {
    super();
    this.connectionManager = connectionManager;
    this.dexConfigs = dexConfigs.filter(dex => dex.enabled);
    this.commitment = commitment;
    this.status = {
      isActive: false,
      subscriptions: [],
      eventsProcessed: 0,
      errors: 0,
    };

    // Listen for connection status changes
    this.connectionManager.on('connected', this.handleConnectionRestored.bind(this));
    this.connectionManager.on('disconnected', this.handleConnectionLost.bind(this));
  }

  /**
   * Start monitoring blockchain for new pool creation events
   */
  async start(): Promise<void> {
    if (this.status.isActive) {
      throw new Error('BlockchainWatcher is already active');
    }

    try {
      // Ensure connection is established
      const connection = this.connectionManager.getConnection();
      if (!connection) {
        throw new Error('Connection not established');
      }

      // Subscribe to each enabled DEX
      for (const dex of this.dexConfigs) {
        await this.subscribeToDex(dex, connection);
      }

      this.status.isActive = true;
      this.emit('started');

      // Emit log event
      this.emit('log', {
        level: 'info',
        message: `BlockchainWatcher started monitoring ${this.dexConfigs.length} DEXes`,
        timestamp: Date.now(),
        data: { dexes: this.dexConfigs.map(d => d.name) },
      });
    } catch (error) {
      this.status.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('error', new Error(`Failed to start BlockchainWatcher: ${errorMessage}`));
      throw error;
    }
  }

  /**
   * Stop monitoring and clean up subscriptions
   */
  async stop(): Promise<void> {
    if (!this.status.isActive) {
      return;
    }

    this.isShuttingDown = true;

    try {
      const connection = this.connectionManager.getConnection();
      if (connection) {
        // Remove all subscriptions
        for (const subId of this.subscriptions) {
          try {
            await connection.removeOnLogsListener(subId);
          } catch (error) {
            // Log but don't throw - cleanup should continue
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.emit('log', {
              level: 'warning',
              message: `Failed to remove subscription ${subId}: ${errorMessage}`,
              timestamp: Date.now(),
            });
          }
        }
      }

      this.subscriptions = [];
      this.status.subscriptions = [];
      this.status.isActive = false;

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      this.emit('stopped');
      this.emit('log', {
        level: 'info',
        message: 'BlockchainWatcher stopped',
        timestamp: Date.now(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('error', new Error(`Error stopping BlockchainWatcher: ${errorMessage}`));
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Pause monitoring (keeps subscriptions but ignores events)
   */
  pause(): void {
    if (this.status.isActive) {
      this.status.isActive = false;
      this.emit('paused');
      this.emit('log', {
        level: 'info',
        message: 'BlockchainWatcher paused',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Resume monitoring
   */
  resume(): void {
    if (!this.status.isActive && this.subscriptions.length > 0) {
      this.status.isActive = true;
      this.emit('resumed');
      this.emit('log', {
        level: 'info',
        message: 'BlockchainWatcher resumed',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Get current watcher status
   */
  getStatus(): WatcherStatus {
    return { ...this.status };
  }

  /**
   * Subscribe to a specific DEX program logs
   */
  private async subscribeToDex(dex: DexConfig, connection: Connection): Promise<void> {
    try {
      const programId = new PublicKey(dex.programId);

      const subId = connection.onLogs(programId, this.createLogHandler(dex), this.commitment);

      this.subscriptions.push(subId);
      this.status.subscriptions.push(subId);

      this.emit('log', {
        level: 'info',
        message: `Subscribed to ${dex.name} (Program ID: ${dex.programId})`,
        timestamp: Date.now(),
        data: { dex: dex.name, programId: dex.programId, subscriptionId: subId },
      });
    } catch (error) {
      this.status.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to subscribe to ${dex.name}: ${errorMessage}`);
    }
  }

  /**
   * Create log handler for a specific DEX
   */
  private createLogHandler(dex: DexConfig): LogsCallback {
    return ({ logs, err, signature }) => {
      if (err || !this.status.isActive || this.isShuttingDown) {
        if (err) {
          this.status.errors++;
          const errorMessage = typeof err === 'string' ? err : (err as any)?.message || String(err);
          this.emit('log', {
            level: 'error',
            message: `Log subscription error for ${dex.name}: ${errorMessage}`,
            timestamp: Date.now(),
            data: { dex: dex.name, error: errorMessage },
          });
        }
        return;
      }

      // Check if logs contain pool creation instruction
      if (logs && this.containsPoolCreationInstruction(logs, dex)) {
        this.handleNewPoolEvent(signature, dex);
      }
    };
  }

  /**
   * Check if logs contain pool creation instruction
   */
  private containsPoolCreationInstruction(logs: string[], dex: DexConfig): boolean {
    const poolCreationInstruction = dex.instructions.newPoolCreation;
    return logs.some(log => log.includes(poolCreationInstruction));
  }

  /**
   * Handle new pool creation event
   */
  private async handleNewPoolEvent(signature: string, dex: DexConfig): Promise<void> {
    try {
      const connection = this.connectionManager.getConnection();
      if (!connection) {
        throw new Error('Connection not available');
      }

      // Fetch the transaction details
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: this.commitment,
      });

      if (!tx) {
        throw new Error(`Transaction ${signature} not found`);
      }

      // Parse pool information from transaction
      const poolInfo = this.parsePoolCreationTransaction(tx, dex);

      if (poolInfo) {
        const poolEvent: NewPoolEvent = {
          signature,
          dex: dex.name,
          poolAddress: poolInfo.poolAddress,
          tokenA: poolInfo.tokenA,
          tokenB: poolInfo.tokenB,
          timestamp: Date.now(),
          creator: poolInfo.creator,
          baseToken: poolInfo.baseToken,
          quoteToken: poolInfo.quoteToken,
          programId: poolInfo.programId,
          instructionType: poolInfo.instructionType,
          initialLiquidityUsd: poolInfo.initialLiquidity,
        };

        this.status.eventsProcessed++;
        this.status.lastEventTime = Date.now();

        // Emit the new pool event
        this.emit('newPool', poolEvent);

        this.emit('log', {
          level: 'info',
          message: `New pool detected on ${dex.name}: ${poolInfo.poolAddress}`,
          timestamp: Date.now(),
          data: {
            dex: dex.name,
            poolAddress: poolInfo.poolAddress,
            tokenA: poolInfo.tokenA,
            tokenB: poolInfo.tokenB,
            baseToken: poolInfo.baseToken,
            quoteToken: poolInfo.quoteToken,
            creator: poolInfo.creator,
            programId: poolInfo.programId,
            instructionType: poolInfo.instructionType,
            signature,
          },
        });
      }
    } catch (error) {
      this.status.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('log', {
        level: 'error',
        message: `Error processing transaction ${signature}: ${errorMessage}`,
        timestamp: Date.now(),
        data: { signature, dex: dex.name, error: errorMessage },
      });
    }
  }

  /**
   * Parse pool creation transaction to extract pool and token information
   * Uses DEX-specific parsers for accurate pool detection
   */
  private parsePoolCreationTransaction(
    tx: ParsedTransactionWithMeta,
    dex: DexConfig,
  ): PoolInfo | null {
    try {
      // Create appropriate parser for this DEX
      const parser = createDexParser(dex);
      
      // Use DEX-specific parser to extract pool information
      const poolCreationInfo = parser.parsePoolCreation(tx, dex);
      
      if (!poolCreationInfo) {
        return null;
      }
      
      // Convert PoolCreationInfo to PoolInfo format
      return {
        poolAddress: poolCreationInfo.poolAddress,
        tokenA: poolCreationInfo.tokenA,
        tokenB: poolCreationInfo.tokenB,
        creator: poolCreationInfo.creator,
        baseToken: poolCreationInfo.baseToken,
        quoteToken: poolCreationInfo.quoteToken,
        programId: poolCreationInfo.programId,
        instructionType: poolCreationInfo.instructionType,
        initialLiquidity: poolCreationInfo.initialLiquidityUsd,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('log', {
        level: 'warning',
        message: `Failed to parse pool creation transaction: ${errorMessage}`,
        timestamp: Date.now(),
        data: { signature: tx.transaction.signatures[0], dex: dex.name, error: errorMessage },
      });
      return null;
    }
  }

  /**
   * Check if instruction is a pool creation instruction using DEX-specific parser
   */
  private isPoolCreationInstructionType(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    dex: DexConfig,
  ): boolean {
    try {
      const parser = createDexParser(dex);
      return parser.isPoolCreationInstruction(instruction, dex);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('log', {
        level: 'debug',
        message: `Error checking pool creation instruction: ${errorMessage}`,
        timestamp: Date.now(),
        data: { dex: dex.name, error: errorMessage },
      });
      return false;
    }
  }

  /**
   * Handle connection restored event
   */
  private async handleConnectionRestored(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      // Clear any existing reconnect timeout
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      // Re-establish subscriptions if we were active before
      if (this.subscriptions.length === 0 && this.dexConfigs.length > 0) {
        const connection = this.connectionManager.getConnection();
        if (connection) {
          for (const dex of this.dexConfigs) {
            await this.subscribeToDex(dex, connection);
          }

          this.status.isActive = true;
          this.emit('reconnected');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit('log', {
        level: 'error',
        message: `Failed to restore subscriptions after reconnection: ${errorMessage}`,
        timestamp: Date.now(),
      });

      // Schedule retry
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection lost event
   */
  private handleConnectionLost(): Promise<void> {
    this.subscriptions = [];
    this.status.subscriptions = [];

    if (!this.isShuttingDown) {
      this.emit('log', {
        level: 'warning',
        message: 'Connection lost, subscriptions cleared',
        timestamp: Date.now(),
      });

      this.scheduleReconnect();
    }

    return Promise.resolve();
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.isShuttingDown) {
      return;
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      if (this.connectionManager.getStatus().isConnected) {
        await this.handleConnectionRestored();
      } else {
        this.scheduleReconnect();
      }
    }, 5000); // Retry every 5 seconds
  }
}
