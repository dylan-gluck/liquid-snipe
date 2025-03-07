import { eventEmitter } from './event-emitter';
import { LogEvent } from '../types';

export class Logger {
  private verbose: boolean;
  private context: string;

  constructor(context: string, verbose = false) {
    this.context = context;
    this.verbose = verbose;
  }

  public setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  public info(message: string, data?: Record<string, any>): void {
    this.log('info', message, data);
  }

  public warning(message: string, data?: Record<string, any>): void {
    this.log('warning', message, data);
  }

  public error(message: string, data?: Record<string, any>): void {
    this.log('error', message, data);
  }

  public success(message: string, data?: Record<string, any>): void {
    this.log('success', message, data);
  }

  public debug(message: string, data?: Record<string, any>): void {
    if (this.verbose) {
      this.log('debug', message, data);
    }
  }

  private log(level: LogEvent['level'], message: string, data?: Record<string, any>): void {
    const logEvent: LogEvent = {
      level,
      message: `[${this.context}] ${message}`,
      timestamp: Date.now(),
      data,
    };

    // Emit the log event
    eventEmitter.emit('log', logEvent);

    // Also log to console
    this.consoleLog(logEvent);
  }

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