import { AppConfig, NewPoolEvent, TradeDecision, TradeResult } from '../types';
import { Logger } from '../utils/logger';
import { EventEmitter } from '../utils/event-emitter';
import DatabaseManager from '../db';
import { ConnectionManager } from '../blockchain';
import { BlockchainWatcher } from '../blockchain/blockchain-watcher';
import { TokenInfoService } from '../blockchain/token-info-service';
import { StrategyEngine } from '../trading/strategy-engine';
import { TradeExecutor } from '../trading/trade-executor';
import { PositionManager } from '../trading/position-manager';
import { TuiController } from '../tui';
import { EventManager } from '../events/event-manager';

export class CoreController {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private eventManager: EventManager;
  private dbManager: DatabaseManager;
  private connectionManager: ConnectionManager;
  private blockchainWatcher?: BlockchainWatcher;
  private tokenInfoService?: TokenInfoService;
  private strategyEngine?: StrategyEngine;
  private tradeExecutor?: TradeExecutor;
  private positionManager?: PositionManager;
  private tuiController?: TuiController;
  private config: AppConfig;
  private shuttingDown = false;
  private positionMonitoringInterval?: NodeJS.Timeout;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger('CoreController', { verbose: config.verbose });
    this.eventEmitter = new EventEmitter();
    this.dbManager = new DatabaseManager(config.database.path, {
      verbose: config.verbose,
      logToDatabase: true,
    });
    this.connectionManager = new ConnectionManager(config.rpc);
    
    // Initialize event manager
    this.eventManager = new EventManager({
      storeEvents: true,
      logToConsole: config.verbose,
    }, this.dbManager);

    // Connect logger to event manager
    this.logger.setEventEmitter(logEvent => {
      this.eventManager.emit('log', logEvent);
    });
  }

  public async initialize(): Promise<void> {
    this.logger.info('Initializing Liquid-Snipe...');

    // Emit system status
    this.eventManager.emit('systemStatus', {
      status: 'STARTING',
      timestamp: Date.now(),
    });

    try {
      // Initialize database
      await this.dbManager.initialize();
      this.logger.info('Database initialized');

      // Initialize Solana connection
      await this.connectionManager.initialize();
      this.logger.info('Solana RPC connection established');

      // Emit connection status
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'CONNECTED',
        endpoint: this.config.rpc.httpUrl,
        timestamp: Date.now(),
      });

      // Initialize core trading components
      await this.initializeTradingComponents();

      // Initialize blockchain monitoring
      await this.initializeBlockchainWatcher();

      // Register shutdown handlers
      this.registerShutdownHandlers();

      // Register event handlers
      this.registerEventHandlers();

      // Initialize TUI if not disabled
      if (!this.config.disableTui) {
        this.tuiController = new TuiController(
          this.config,
          this.dbManager,
          this.eventManager
        );
      }

      // Emit ready status
      this.eventManager.emit('systemStatus', {
        status: 'READY',
        timestamp: Date.now(),
      });

      this.logger.info('Liquid-Snipe initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize: ${(error as Error).message}`);
      
      // Emit error status
      this.eventManager.emit('systemStatus', {
        status: 'ERROR',
        timestamp: Date.now(),
        reason: (error as Error).message,
      });
      
      throw error;
    }
  }

  private async initializeTradingComponents(): Promise<void> {
    this.logger.info('Initializing trading components...');

    // Initialize token info service
    this.tokenInfoService = new TokenInfoService(
      this.connectionManager,
      this.dbManager,
      {
        cacheExpiryMinutes: 30,
      }
    );

    // Initialize strategy engine
    this.strategyEngine = new StrategyEngine(
      this.connectionManager,
      this.tokenInfoService,
      this.dbManager,
      this.config
    );

    // Initialize trade executor
    this.tradeExecutor = new TradeExecutor(
      this.connectionManager,
      this.dbManager,
      this.config
    );

    // Initialize position manager
    this.positionManager = new PositionManager(
      this.dbManager,
      this.eventManager
    );

    this.logger.info('Trading components initialized');
  }

  private async initializeBlockchainWatcher(): Promise<void> {
    // Only initialize if we have enabled DEXes
    const enabledDexes = this.config.supportedDexes.filter(dex => dex.enabled);
    
    if (enabledDexes.length === 0) {
      this.logger.warning('No DEXes enabled - blockchain monitoring disabled');
      return;
    }

    this.logger.info(`Initializing blockchain watcher for ${enabledDexes.length} DEXes...`);

    this.blockchainWatcher = new BlockchainWatcher(
      this.connectionManager,
      enabledDexes,
      'finalized'
    );

    // Connect blockchain watcher events
    this.blockchainWatcher.on('newPool', (poolEvent: NewPoolEvent) => {
      this.handleNewPoolEvent(poolEvent);
    });

    this.blockchainWatcher.on('error', (error: Error) => {
      this.logger.error(`Blockchain watcher error: ${error.message}`);
      this.eventManager.emit('systemStatus', {
        status: 'ERROR',
        timestamp: Date.now(),
        reason: `Blockchain watcher: ${error.message}`,
      });
    });

    this.logger.info('Blockchain watcher initialized');
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Liquid-Snipe...');

    try {
      // Start blockchain monitoring if enabled
      if (this.blockchainWatcher) {
        await this.blockchainWatcher.start();
        this.logger.info('Blockchain monitoring started');
      }

      // Start position monitoring
      this.startPositionMonitoring();

      // Start in dry run mode if configured
      if (this.config.dryRun) {
        this.logger.info('Running in DRY RUN mode - no trades will be executed');
      }

      // Start TUI or console mode based on configuration
      if (this.config.disableTui) {
        this.logger.info('TUI disabled - running in console mode');
        // In console mode, keep the process alive
        this.startConsoleMode();
      } else {
        this.logger.info('TUI enabled - starting interface');
        if (this.tuiController) {
          this.tuiController.start();
        }
      }

      this.logger.info('Liquid-Snipe started successfully');
    } catch (error) {
      this.logger.error(`Failed to start: ${(error as Error).message}`);
      throw error;
    }
  }

  public getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  public getConnection() {
    return this.connectionManager.getConnection();
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.logger.info('Shutting down Liquid-Snipe...');

    // Emit shutdown status
    this.eventManager.emit('systemStatus', {
      status: 'SHUTDOWN',
      timestamp: Date.now(),
    });

    try {
      // Stop position monitoring
      if (this.positionMonitoringInterval) {
        clearInterval(this.positionMonitoringInterval);
      }

      // Stop blockchain watcher
      if (this.blockchainWatcher) {
        await this.blockchainWatcher.stop();
        this.logger.info('Blockchain watcher stopped');
      }

      // Stop TUI if running
      if (this.tuiController) {
        this.tuiController.stop();
        this.logger.info('TUI stopped');
      }

      // Shutdown connection manager
      await this.connectionManager.shutdown();
      this.logger.info('Connection manager shutdown');

      // Close database connection
      await this.dbManager.close();
      this.logger.info('Database closed');

      this.logger.info('Shutdown completed successfully');
    } catch (error) {
      this.logger.error(`Error during shutdown: ${(error as Error).message}`);
    }
  }

  private startConsoleMode(): void {
    // In console mode, periodically log status updates
    const logInterval = setInterval(() => {
      if (this.shuttingDown) {
        clearInterval(logInterval);
        return;
      }

      // Log periodic status updates
      this.logger.info('System running in console mode...');
      
      // TODO: Add more detailed status logging when other components are implemented
    }, 30000); // Log every 30 seconds

    // Keep process alive
    process.stdin.resume();
  }

  // Public methods for accessing managers
  public getEventManager(): EventManager {
    return this.eventManager;
  }

  public getDatabaseManager(): DatabaseManager {
    return this.dbManager;
  }

  public getTuiController(): TuiController | undefined {
    return this.tuiController;
  }

  private registerEventHandlers(): void {
    // Connection event handlers
    this.connectionManager.on('connected', status => {
      this.logger.info(`Connected to Solana RPC (latency: ${status.pingLatency}ms)`);
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'CONNECTED',
        endpoint: this.config.rpc.httpUrl,
        latency: status.pingLatency,
        timestamp: Date.now(),
      });
    });

    this.connectionManager.on('disconnected', status => {
      this.logger.warning(`Disconnected from Solana RPC: ${status.lastError}`);
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'DISCONNECTED',
        endpoint: this.config.rpc.httpUrl,
        timestamp: Date.now(),
        error: status.lastError,
      });
    });

    this.connectionManager.on('reconnected', status => {
      this.logger.info(`Reconnected to Solana RPC after ${status.reconnectAttempts} attempts`);
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'CONNECTED',
        endpoint: this.config.rpc.httpUrl,
        latency: status.pingLatency,
        timestamp: Date.now(),
      });
    });

    this.connectionManager.on('reconnectFailed', ({ error, attempt }) => {
      this.logger.error(`Reconnection attempt ${attempt} failed: ${error}`);
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'RECONNECTING',
        endpoint: this.config.rpc.httpUrl,
        timestamp: Date.now(),
        error,
      });
    });

    this.connectionManager.on('maxReconnectAttemptsReached', status => {
      this.logger.error('Maximum reconnection attempts reached - connection lost');
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'ERROR',
        endpoint: this.config.rpc.httpUrl,
        timestamp: Date.now(),
        error: 'Maximum reconnection attempts reached',
      });
    });

    this.connectionManager.on('error', error => {
      this.logger.error(`Connection error: ${error.message}`);
      this.eventManager.emit('connectionStatus', {
        type: 'RPC',
        status: 'ERROR',
        endpoint: this.config.rpc.httpUrl,
        timestamp: Date.now(),
        error: error.message,
      });
    });

    // Register workflow event handlers
    this.eventManager.on('newPool', (poolEvent: NewPoolEvent) => {
      this.handleNewPoolEvent(poolEvent);
    });

    this.eventManager.on('tradeDecision', (decision: TradeDecision) => {
      this.handleTradeDecision(decision);
    });

    this.eventManager.on('tradeResult', (result: TradeResult) => {
      this.handleTradeResult(result);
    });
  }

  private registerShutdownHandlers(): void {
    // Handle process termination signals
    process.on('SIGINT', async () => {
      this.logger.info('Received SIGINT signal');
      await this.shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      this.logger.info('Received SIGTERM signal');
      await this.shutdown();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async error => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack || '');
      await this.shutdown();
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', async reason => {
      this.logger.error(`Unhandled promise rejection: ${reason}`);
      await this.shutdown();
      process.exit(1);
    });
  }

  // Core workflow handlers
  private async handleNewPoolEvent(poolEvent: NewPoolEvent): Promise<void> {
    try {
      this.logger.info(`New pool detected: ${poolEvent.poolAddress} (${poolEvent.tokenA}/${poolEvent.tokenB})`);

      // Save pool to database
      await this.dbManager.addLiquidityPool({
        address: poolEvent.poolAddress,
        dexName: poolEvent.dex,
        tokenA: poolEvent.tokenA,
        tokenB: poolEvent.tokenB,
        createdAt: poolEvent.timestamp,
        initialLiquidityUsd: 0, // Will be updated after evaluation
        lastUpdated: poolEvent.timestamp,
        currentLiquidityUsd: 0,
      });

      // Emit pool event for other components
      this.eventManager.emit('newPool', poolEvent);

      // Evaluate pool for trading if strategy engine is available
      if (this.strategyEngine) {
        const decision = await this.strategyEngine.evaluatePool(poolEvent);
        
        if (decision) {
          this.eventManager.emit('tradeDecision', decision);
        }
      }
    } catch (error) {
      this.logger.error(`Error handling new pool event: ${(error as Error).message}`);
    }
  }

  private async handleTradeDecision(decision: TradeDecision): Promise<void> {
    try {
      this.logger.info(`Trade decision: ${decision.shouldTrade ? 'BUY' : 'SKIP'} ${decision.targetToken}`);
      
      if (decision.shouldTrade) {
        if (this.config.dryRun) {
          this.logger.info(`[DRY RUN] Would execute trade: ${decision.tradeAmountUsd} USD for ${decision.targetToken}`);
          this.logger.info(`[DRY RUN] Reason: ${decision.reason}`);
          
          // Emit a mock success result for dry run
          this.eventManager.emit('tradeResult', {
            success: true,
            signature: 'DRY_RUN_SIGNATURE',
            tradeId: 'DRY_RUN_TRADE',
            positionId: 'DRY_RUN_POSITION',
            timestamp: Date.now(),
          });
        } else if (this.tradeExecutor) {
          // Execute the trade
          const result = await this.tradeExecutor.executeTrade(decision);
          this.eventManager.emit('tradeResult', result);
        }
      } else {
        this.logger.info(`Trade skipped: ${decision.reason}`);
      }
    } catch (error) {
      this.logger.error(`Error handling trade decision: ${(error as Error).message}`);
      
      // Emit failed result
      this.eventManager.emit('tradeResult', {
        success: false,
        error: (error as Error).message,
        timestamp: Date.now(),
      });
    }
  }

  private async handleTradeResult(result: TradeResult): Promise<void> {
    try {
      if (result.success) {
        this.logger.info(`Trade executed successfully: ${result.signature}`);
        
        if (result.positionId && this.positionManager) {
          // The position is automatically tracked in the database
          this.logger.info(`New position created: ${result.positionId}`);
        }
      } else {
        this.logger.error(`Trade execution failed: ${result.error}`);
      }
    } catch (error) {
      this.logger.error(`Error handling trade result: ${(error as Error).message}`);
    }
  }

  private startPositionMonitoring(): void {
    if (!this.positionManager) {
      this.logger.warning('Position manager not available - position monitoring disabled');
      return;
    }

    this.logger.info('Starting position monitoring...');

    // Check positions every minute
    this.positionMonitoringInterval = setInterval(async () => {
      if (this.shuttingDown) {
        return;
      }

      try {
        await this.checkAndExitPositions();
      } catch (error) {
        this.logger.error(`Error in position monitoring: ${(error as Error).message}`);
      }
    }, 60000); // 60 seconds
  }

  private async checkAndExitPositions(): Promise<void> {
    if (!this.positionManager) {
      return;
    }

    try {
      const openPositions = await this.dbManager.getOpenPositions();
      
      if (openPositions.length > 0) {
        this.logger.debug(`Checking ${openPositions.length} open positions for exit conditions`);
        
        for (const position of openPositions) {
          try {
            // Get position model from database
            const positionModel = await this.positionManager.getPosition(position.id);
            if (!positionModel) {
              this.logger.warning(`Position ${position.id} not found in database`);
              continue;
            }

            // For now, use a placeholder current price - in real implementation,
            // this would come from the token info service
            const currentPrice = {
              tokenAddress: position.tokenAddress,
              price: position.entryPrice, // Placeholder
              timestamp: Date.now(),
              source: 'placeholder',
            };

            const exitResult = this.positionManager.evaluateExitConditions(positionModel, currentPrice);
            
            if (exitResult.shouldExit) {
              this.logger.info(`Exit condition met for position ${position.id}: ${exitResult.reason}`);
              
              if (this.config.dryRun) {
                this.logger.info(`[DRY RUN] Would exit position ${position.id}`);
              } else {
                await this.positionManager.processExitRequest({
                  positionId: position.id,
                  reason: exitResult.reason,
                  urgency: exitResult.urgency,
                  partialExitPercentage: exitResult.partialExitPercentage,
                });
              }
            }
          } catch (positionError) {
            this.logger.error(`Error checking position ${position.id}: ${(positionError as Error).message}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error checking positions: ${(error as Error).message}`);
    }
  }

  // Public access methods for components
  public getStrategyEngine(): StrategyEngine | undefined {
    return this.strategyEngine;
  }

  public getTradeExecutor(): TradeExecutor | undefined {
    return this.tradeExecutor;
  }

  public getPositionManager(): PositionManager | undefined {
    return this.positionManager;
  }

  public getTokenInfoService(): TokenInfoService | undefined {
    return this.tokenInfoService;
  }

  public getBlockchainWatcher(): BlockchainWatcher | undefined {
    return this.blockchainWatcher;
  }
}

export default CoreController;
