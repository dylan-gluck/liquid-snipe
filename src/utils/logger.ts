import { LogEvent } from '../types';

/**
 * Options for configuring a Logger instance
 */
export interface LoggerOptions {
  /**
   * Enable verbose logging (including debug level logs)
   */
  verbose?: boolean;

  /**
   * Whether to emit log events
   */
  emitEvents?: boolean;

  /**
   * Whether to output to the console
   */
  consoleOutput?: boolean;

  /**
   * Minimum log level to output
   */
  minLevel?: LogEvent['level'];
}

/**
 * Logger provides consistent logging throughout the application.
 * It outputs to the console and allows event emission through a callback.
 */
export class Logger {
  private context: string;
  private options: Required<LoggerOptions>;
  private eventEmitter?: (event: LogEvent) => void;

  private static readonly levelOrder: Record<LogEvent['level'], number> = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3,
    success: 4,
  };

  /**
   * Create a new Logger instance
   * @param context The context/module name for this logger
   * @param options Configuration options
   */
  constructor(context: string, options: LoggerOptions = {}) {
    this.context = context;

    // Set default options
    this.options = {
      verbose: options.verbose ?? false,
      emitEvents: options.emitEvents ?? true,
      consoleOutput: options.consoleOutput ?? true,
      minLevel: options.minLevel ?? 'debug',
    };
  }

  /**
   * Update logger options
   */
  public setOptions(options: LoggerOptions): void {
    this.options = {
      ...this.options,
      ...options,
    };
  }

  /**
   * Set the event emitter callback
   */
  public setEventEmitter(emitter: (event: LogEvent) => void): void {
    this.eventEmitter = emitter;
  }

  /**
   * Set verbose mode
   */
  public setVerbose(verbose: boolean): void {
    this.options.verbose = verbose;
  }

  /**
   * Log an informational message
   */
  public info(message: string, data?: Record<string, any>): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning message
   */
  public warning(message: string, data?: Record<string, any>): void {
    this.log('warning', message, data);
  }

  /**
   * Log a warning message (alias for warning)
   */
  public warn(message: string, data?: Record<string, any>): void {
    this.log('warning', message, data);
  }

  /**
   * Log an error message
   */
  public error(message: string, data?: Record<string, any>): void {
    this.log('error', message, data);
  }

  /**
   * Log a success message
   */
  public success(message: string, data?: Record<string, any>): void {
    this.log('success', message, data);
  }

  /**
   * Log a debug message - only shown in verbose mode
   */
  public debug(message: string, data?: Record<string, any>): void {
    if (this.options.verbose) {
      this.log('debug', message, data);
    }
  }

  /**
   * Create a child logger with a derived context
   * @param subContext The sub-context to append to the current context
   */
  public child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`, this.options);
  }

  /**
   * Log a message with the specified level
   */
  private log(level: LogEvent['level'], message: string, data?: Record<string, any>): void {
    // Skip if the level is below the minimum
    if (Logger.levelOrder[level] < Logger.levelOrder[this.options.minLevel]) {
      return;
    }

    // Create the log event
    const logEvent: LogEvent = {
      level,
      message: `[${this.context}] ${message}`,
      timestamp: Date.now(),
      data,
    };

    // Emit the log event if emitter is set
    if (this.options.emitEvents && this.eventEmitter) {
      this.eventEmitter(logEvent);
    }

    // Also log to console if enabled
    if (this.options.consoleOutput) {
      this.consoleLog(logEvent);
    }
  }

  /**
   * Output a log event to the console
   */
  private consoleLog(logEvent: LogEvent): void {
    const timestamp = new Date(logEvent.timestamp).toISOString();
    const prefix = `${timestamp} [${logEvent.level.toUpperCase()}]`;

    switch (logEvent.level) {
      case 'info':
        console.info(`${prefix} ${logEvent.message}`);
        break;
      case 'warning':
        console.warn(`${prefix} ${logEvent.message}`);
        break;
      case 'error':
        console.error(`${prefix} ${logEvent.message}`);
        break;
      case 'success':
        console.log(`${prefix} ${logEvent.message}`);
        break;
      case 'debug':
        console.debug(`${prefix} ${logEvent.message}`);
        break;
    }

    if (logEvent.data && Object.keys(logEvent.data).length > 0) {
      console.log('Data:', logEvent.data);
    }
  }
}

// Create a default logger instance
export const logger = new Logger('App');
export default logger;
