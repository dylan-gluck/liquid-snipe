import { AppConfig } from '../types';
import { Logger } from '../utils/logger';
import { EventEmitter } from '../utils/event-emitter';
import DatabaseManager from '../db';
import { ConnectionManager } from '../blockchain';
import { TuiController } from '../tui';
import { EventManager } from '../events/event-manager';

export class CoreController {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private eventManager: EventManager;
  private dbManager: DatabaseManager;
  private connectionManager: ConnectionManager;
  private tuiController?: TuiController;
  private config: AppConfig;
  private shuttingDown = false;

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

    // Initialize database
    await this.dbManager.initialize();

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
      // In console mode, keep the process alive
      this.startConsoleMode();
    } else {
      this.logger.info('TUI enabled - starting interface');
      if (this.tuiController) {
        this.tuiController.start();
      }
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

    // Emit shutdown status
    this.eventManager.emit('systemStatus', {
      status: 'SHUTDOWN',
      timestamp: Date.now(),
    });

    try {
      // Stop TUI if running
      if (this.tuiController) {
        this.tuiController.stop();
      }

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
}

export default CoreController;
