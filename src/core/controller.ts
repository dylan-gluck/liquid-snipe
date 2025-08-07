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
import { PriceFeedService } from '../data/price-feed-service';
import { MarketDataManager } from '../data/market-data-manager';
import { TuiController } from '../tui';
import { EventManager } from '../events/event-manager';
import {
  TradingWorkflowCoordinator,
  PositionWorkflowCoordinator,
  UserInteractionWorkflowCoordinator,
  DataManagementWorkflowCoordinator,
  ErrorRecoveryWorkflowCoordinator,
} from './workflows';
import { SystemStateMachine, SystemStateTransition } from './state-machines/system-state-machine';

export class CoreController {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private eventManager: EventManager;
  private dbManager: DatabaseManager;
  private connectionManager: ConnectionManager;
  private blockchainWatcher?: BlockchainWatcher;
  private tokenInfoService?: TokenInfoService;
  private priceFeedService?: PriceFeedService;
  private marketDataManager?: MarketDataManager;
  private strategyEngine?: StrategyEngine;
  private tradeExecutor?: TradeExecutor;
  private positionManager?: PositionManager;
  private tuiController?: TuiController;

  // Workflow coordinators
  private tradingWorkflow?: TradingWorkflowCoordinator;
  private positionWorkflow?: PositionWorkflowCoordinator;
  private userInteractionWorkflow?: UserInteractionWorkflowCoordinator;
  private dataManagementWorkflow?: DataManagementWorkflowCoordinator;
  private errorRecoveryWorkflow?: ErrorRecoveryWorkflowCoordinator;

  // System state machine
  private systemStateMachine: SystemStateMachine;

  private config: AppConfig;
  private shuttingDown = false;
  private positionMonitoringInterval?: NodeJS.Timeout;
  private processListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private disableProcessHandlers: boolean;

  constructor(config: AppConfig, options: { disableProcessHandlers?: boolean } = {}) {
    this.config = config;
    this.disableProcessHandlers = options.disableProcessHandlers || false;
    this.logger = new Logger('CoreController', { verbose: config.verbose });
    this.eventEmitter = new EventEmitter();
    this.dbManager = new DatabaseManager(config.database.path, {
      verbose: config.verbose,
      logToDatabase: true,
    });
    this.connectionManager = new ConnectionManager(config.rpc);

    // Initialize system state machine
    this.systemStateMachine = new SystemStateMachine();

    // Initialize event manager
    this.eventManager = new EventManager(
      {
        storeEvents: true,
        logToConsole: config.verbose,
      },
      this.dbManager,
    );

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
      this.systemStateMachine.updateComponentStatus('database', 'CONNECTED');
      this.logger.info('Database initialized');

      // Initialize Solana connection
      await this.connectionManager.initialize();
      this.systemStateMachine.updateComponentStatus('rpc', 'CONNECTED');
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

      // Initialize workflow coordinators
      await this.initializeWorkflowCoordinators();

      // Initialize blockchain monitoring
      await this.initializeBlockchainWatcher();

      // Register shutdown handlers
      this.registerShutdownHandlers();

      // Register event handlers
      this.registerEventHandlers();

      // Initialize TUI if not disabled
      if (!this.config.disableTui) {
        this.tuiController = new TuiController(this.config, this.dbManager, this.eventManager);
      }

      // Transition to ready state
      this.systemStateMachine.transition(SystemStateTransition.INITIALIZATION_COMPLETED);

      // Emit ready status
      this.eventManager.emit('systemStatus', {
        status: 'READY',
        timestamp: Date.now(),
      });

      this.logger.info('Liquid-Snipe initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize: ${(error as Error).message}`);

      // Transition to error state
      this.systemStateMachine.transition(SystemStateTransition.ERROR_OCCURRED, {
        lastError: error as Error,
      });

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

    // Initialize Price Feed Service
    this.priceFeedService = new PriceFeedService();
    this.logger.info('Price Feed Service initialized');

    // Initialize Market Data Manager
    this.marketDataManager = new MarketDataManager(this.priceFeedService);
    this.logger.info('Market Data Manager initialized');

    // Initialize token info service with price feed integration
    this.tokenInfoService = new TokenInfoService(this.connectionManager, this.dbManager, {
      cacheExpiryMinutes: 30,
      priceFeedService: this.priceFeedService,
    });

    // Initialize strategy engine with real-time market data
    this.strategyEngine = new StrategyEngine(
      this.connectionManager,
      this.tokenInfoService,
      this.priceFeedService,
      this.dbManager,
      this.config,
    );

    // Initialize trade executor
    this.tradeExecutor = new TradeExecutor(this.connectionManager, this.dbManager, this.config);

    // Initialize position manager
    this.positionManager = new PositionManager(this.dbManager, this.eventManager);

    this.logger.info('Trading components initialized');
  }

  private async initializeWorkflowCoordinators(): Promise<void> {
    this.logger.info('Initializing workflow coordinators...');

    // Initialize error recovery workflow first (it handles errors from other components)
    this.errorRecoveryWorkflow = new ErrorRecoveryWorkflowCoordinator(
      this.eventManager,
      this.connectionManager,
      this.dbManager,
    );

    // Initialize trading workflow coordinator
    if (this.strategyEngine && this.tradeExecutor) {
      this.tradingWorkflow = new TradingWorkflowCoordinator(
        this.eventManager,
        this.strategyEngine,
        this.tradeExecutor,
        this.dbManager,
        this.config.dryRun,
      );
    }

    // Initialize position workflow coordinator
    if (this.positionManager) {
      this.positionWorkflow = new PositionWorkflowCoordinator(
        this.eventManager,
        this.positionManager,
        this.dbManager,
        this.config.dryRun,
        60000, // 1 minute monitoring interval
      );
    }

    // Initialize user interaction workflow coordinator
    this.userInteractionWorkflow = new UserInteractionWorkflowCoordinator(
      this.eventManager,
      this.dbManager,
      this.config,
    );

    // Initialize data management workflow coordinator
    this.dataManagementWorkflow = new DataManagementWorkflowCoordinator(
      this.eventManager,
      this.dbManager,
      this.config,
    );

    this.logger.info('Workflow coordinators initialized');
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
      'finalized',
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

  private async startWorkflowCoordinators(): Promise<void> {
    this.logger.info('Starting workflow coordinators...');

    // Start position workflow coordinator
    if (this.positionWorkflow) {
      await this.positionWorkflow.startPositionMonitoring();
      this.logger.info('Position workflow coordinator started');
    }

    // Start data management workflow coordinator
    if (this.dataManagementWorkflow) {
      await this.dataManagementWorkflow.startDataManagement();
      this.logger.info('Data management workflow coordinator started');
    }

    // Trading and user interaction workflows are event-driven and start automatically
    // Error recovery workflow is always listening for events

    this.logger.info('Workflow coordinators started');
  }

  private async stopWorkflowCoordinators(): Promise<void> {
    this.logger.info('Stopping workflow coordinators...');

    // Stop position workflow coordinator
    if (this.positionWorkflow) {
      this.positionWorkflow.stopPositionMonitoring();
      this.logger.info('Position workflow coordinator stopped');
    }

    // Stop data management workflow coordinator
    if (this.dataManagementWorkflow) {
      this.dataManagementWorkflow.stopDataManagement();
      this.logger.info('Data management workflow coordinator stopped');
    }

    // Other workflow coordinators don't need explicit stopping as they're event-driven

    this.logger.info('Workflow coordinators stopped');
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Liquid-Snipe...');

    // Transition to running state
    this.systemStateMachine.transition(SystemStateTransition.START_REQUESTED);

    try {
      // Start blockchain monitoring if enabled
      if (this.blockchainWatcher) {
        await this.blockchainWatcher.start();
        this.systemStateMachine.updateComponentStatus('blockchain', 'MONITORING');
        this.logger.info('Blockchain monitoring started');
      }

      // Start workflow coordinators
      await this.startWorkflowCoordinators();

      // Start position monitoring (legacy - now handled by position workflow)
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

    // Transition to shutting down state
    this.systemStateMachine.transition(SystemStateTransition.SHUTDOWN_REQUESTED);

    // Emit shutdown status
    this.eventManager.emit('systemStatus', {
      status: 'SHUTDOWN',
      timestamp: Date.now(),
    });

    try {
      // Stop workflow coordinators
      await this.stopWorkflowCoordinators();

      // Stop position monitoring
      if (this.positionMonitoringInterval) {
        clearInterval(this.positionMonitoringInterval);
        this.positionMonitoringInterval = undefined;
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

      // Remove process event listeners
      this.processListeners.forEach(({ event, handler }) => {
        process.removeListener(event, handler);
      });
      this.processListeners = [];

      // Shutdown connection manager
      await this.connectionManager.shutdown();
      this.logger.info('Connection manager shutdown');

      // Close database connection
      await this.dbManager.close();
      this.systemStateMachine.updateComponentStatus('database', 'DISCONNECTED');
      this.logger.info('Database closed');

      // Transition to stopped state
      this.systemStateMachine.transition(SystemStateTransition.SHUTDOWN_COMPLETED);

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
    // Skip process handlers in test environments
    if (this.disableProcessHandlers) {
      return;
    }

    // Create handlers that can be properly removed
    const sigintHandler = async () => {
      this.logger.info('Received SIGINT signal');
      await this.shutdown();
      process.exit(0);
    };

    const sigtermHandler = async () => {
      this.logger.info('Received SIGTERM signal');
      await this.shutdown();
      process.exit(0);
    };

    const uncaughtExceptionHandler = async (error: Error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack || '');
      await this.shutdown();
      process.exit(1);
    };

    const unhandledRejectionHandler = async (reason: any) => {
      this.logger.error(`Unhandled promise rejection: ${reason}`);
      await this.shutdown();
      process.exit(1);
    };

    // Register handlers and track them
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    process.on('uncaughtException', uncaughtExceptionHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);

    // Store references for cleanup
    this.processListeners.push(
      { event: 'SIGINT', handler: sigintHandler },
      { event: 'SIGTERM', handler: sigtermHandler },
      { event: 'uncaughtException', handler: uncaughtExceptionHandler },
      { event: 'unhandledRejection', handler: unhandledRejectionHandler },
    );
  }

  // Core workflow handlers
  private async handleNewPoolEvent(poolEvent: NewPoolEvent): Promise<void> {
    try {
      this.logger.info(
        `New pool detected: ${poolEvent.poolAddress} (${poolEvent.tokenA}/${poolEvent.tokenB})`,
      );

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
      this.logger.info(
        `Trade decision: ${decision.shouldTrade ? 'BUY' : 'SKIP'} ${decision.targetToken}`,
      );

      if (decision.shouldTrade) {
        if (this.config.dryRun) {
          this.logger.info(
            `[DRY RUN] Would execute trade: ${decision.tradeAmountUsd} USD for ${decision.targetToken}`,
          );
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

            const exitResult = this.positionManager.evaluateExitConditions(
              positionModel,
              currentPrice,
            );

            if (exitResult.shouldExit) {
              this.logger.info(
                `Exit condition met for position ${position.id}: ${exitResult.reason}`,
              );

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
            this.logger.error(
              `Error checking position ${position.id}: ${(positionError as Error).message}`,
            );
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

  // Workflow coordinator access methods
  public getTradingWorkflow(): TradingWorkflowCoordinator | undefined {
    return this.tradingWorkflow;
  }

  public getPositionWorkflow(): PositionWorkflowCoordinator | undefined {
    return this.positionWorkflow;
  }

  public getUserInteractionWorkflow(): UserInteractionWorkflowCoordinator | undefined {
    return this.userInteractionWorkflow;
  }

  public getDataManagementWorkflow(): DataManagementWorkflowCoordinator | undefined {
    return this.dataManagementWorkflow;
  }

  public getErrorRecoveryWorkflow(): ErrorRecoveryWorkflowCoordinator | undefined {
    return this.errorRecoveryWorkflow;
  }

  // System state machine access
  public getSystemStateMachine(): SystemStateMachine {
    return this.systemStateMachine;
  }

  // Enhanced error handling access methods
  public getErrorHandler() {
    return this.errorRecoveryWorkflow?.getErrorHandler();
  }

  public getCircuitBreakerRegistry() {
    return this.errorRecoveryWorkflow?.getCircuitBreakerRegistry();
  }

  public getNotificationSystem() {
    return this.errorRecoveryWorkflow?.getNotificationSystem();
  }

  /**
   * Get comprehensive system health information
   */
  public getSystemHealth(): {
    overallHealthy: boolean;
    components: Record<string, { status: string; healthy: boolean; errors?: number }>;
    errorStats: any;
    circuitBreakers: any;
  } {
    const errorRecoveryStats = this.errorRecoveryWorkflow?.getEnhancedStats();
    const circuitBreakerHealth = this.getCircuitBreakerRegistry()?.getOverallHealth();

    const components: Record<string, { status: string; healthy: boolean; errors?: number }> = {
      database: {
        status: this.systemStateMachine.getComponentStatus('database'),
        healthy: this.systemStateMachine.getComponentStatus('database') === 'CONNECTED',
      },
      rpc: {
        status: this.systemStateMachine.getComponentStatus('rpc'),
        healthy: this.systemStateMachine.getComponentStatus('rpc') === 'CONNECTED',
      },
      blockchain: {
        status: this.systemStateMachine.getComponentStatus('blockchain'),
        healthy: this.systemStateMachine.getComponentStatus('blockchain') === 'MONITORING',
      },
    };

    // Add error counts if available
    if (errorRecoveryStats?.errorHandlerStats) {
      const errorsByComponent = errorRecoveryStats.errorHandlerStats.errorsByComponent;
      Object.keys(components).forEach(component => {
        const componentName = component.charAt(0).toUpperCase() + component.slice(1) + 'Manager';
        components[component].errors = errorsByComponent[componentName] || 0;
      });
    }

    return {
      overallHealthy: circuitBreakerHealth?.overallHealthy ?? true,
      components,
      errorStats: errorRecoveryStats?.errorHandlerStats,
      circuitBreakers: circuitBreakerHealth,
    };
  }
}

export default CoreController;
