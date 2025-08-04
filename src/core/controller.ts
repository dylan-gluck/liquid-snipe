import { AppConfig } from '../types';
import { Logger } from '../utils/logger';
import { EventEmitter } from '../utils/event-emitter';
import DatabaseManager from '../db';
import { ConnectionManager } from '../blockchain';

export class CoreController {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private dbManager: DatabaseManager;
  private connectionManager: ConnectionManager;
  private config: AppConfig;
  private shuttingDown = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger('CoreController', { verbose: config.verbose });
    this.eventEmitter = new EventEmitter();
    this.dbManager = new DatabaseManager(config.database.path);
    this.connectionManager = new ConnectionManager(config.rpc);
    
    // Connect logger to event emitter
    this.logger.setEventEmitter((logEvent) => {
      this.eventEmitter.emit('log', logEvent);
    });
  }

  public async initialize(): Promise<void> {
    this.logger.info('Initializing Liquid-Snipe...');

    // Initialize database
    await this.dbManager.initialize();

    // Initialize Solana connection
    await this.connectionManager.initialize();
    this.logger.info('Solana RPC connection established');

    // Register shutdown handlers
    this.registerShutdownHandlers();

    // Register event handlers
    this.registerEventHandlers();

    this.logger.info('Liquid-Snipe initialized successfully');
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Liquid-Snipe...');

    // TODO: Initialize and start other components (blockchain watcher, strategy engine, etc.)

    // Start in dry run mode if configured
    if (this.config.dryRun) {
      this.logger.info('Running in DRY RUN mode - no trades will be executed');
    }

    // Start TUI or console mode based on configuration
    if (this.config.disableTui) {
      this.logger.info('TUI disabled - running in console mode');
    } else {
      // TODO: Initialize and start TUI
      this.logger.info('TUI enabled - initializing interface');
    }

    this.logger.info('Liquid-Snipe started successfully');
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

    try {
      // Shutdown connection manager
      await this.connectionManager.shutdown();

      // Close database connection
      await this.dbManager.close();

      // TODO: Shutdown other components

      this.logger.info('Shutdown completed successfully');
    } catch (error) {
      this.logger.error(`Error during shutdown: ${(error as Error).message}`);
    }
  }

  private registerEventHandlers(): void {
    // Log event handler
    this.eventEmitter.on('log', (logEvent) => {
      // TODO: Store logs in database
    });

    // Connection event handlers
    this.connectionManager.on('connected', (status) => {
      this.logger.info(`Connected to Solana RPC (latency: ${status.pingLatency}ms)`);
    });

    this.connectionManager.on('disconnected', (status) => {
      this.logger.warning(`Disconnected from Solana RPC: ${status.lastError}`);
    });

    this.connectionManager.on('reconnected', (status) => {
      this.logger.info(`Reconnected to Solana RPC after ${status.reconnectAttempts} attempts`);
    });

    this.connectionManager.on('reconnectFailed', ({ error, attempt }) => {
      this.logger.error(`Reconnection attempt ${attempt} failed: ${error}`);
    });

    this.connectionManager.on('maxReconnectAttemptsReached', (status) => {
      this.logger.error('Maximum reconnection attempts reached - connection lost');
    });

    this.connectionManager.on('error', (error) => {
      this.logger.error(`Connection error: ${error.message}`);
    });

    // TODO: Register handlers for other events (newPool, tradeDecision, tradeResult)
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
    process.on('uncaughtException', async (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack || '');
      await this.shutdown();
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', async (reason) => {
      this.logger.error(`Unhandled promise rejection: ${reason}`);
      await this.shutdown();
      process.exit(1);
    });
  }
}

export default CoreController;