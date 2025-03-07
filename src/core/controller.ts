import { AppConfig } from '../types';
import { Logger } from '../utils/logger';
import { EventEmitter } from '../utils/event-emitter';
import DatabaseManager from '../db';

export class CoreController {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private dbManager: DatabaseManager;
  private config: AppConfig;
  private shuttingDown = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger('CoreController', config.verbose);
    this.eventEmitter = new EventEmitter();
    this.dbManager = new DatabaseManager(config.database.path);
  }

  public async initialize(): Promise<void> {
    this.logger.info('Initializing Liquid-Snipe...');

    // Initialize database
    await this.dbManager.initialize();

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

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.logger.info('Shutting down Liquid-Snipe...');

    try {
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