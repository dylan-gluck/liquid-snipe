import { EventEmitter as NodeEventEmitter } from 'events';
import { LogEvent } from '../types';
import { DatabaseManager } from '../db';
import { Logger } from '../utils/logger';
import { EventMap, EventName, EventHandler, EventProcessor } from './types';

/**
 * Options for configuring the EventManager
 */
export interface EventManagerOptions {
  /**
   * Whether to log all events to the console
   */
  logToConsole?: boolean;
  
  /**
   * Whether to store events in the database
   */
  storeEvents?: boolean;
  
  /**
   * Maximum number of listeners per event type
   */
  maxListeners?: number;
  
  /**
   * Events to exclude from logging/storing
   */
  excludedEvents?: EventName[];
}

/**
 * EventManager is the central hub for the event system.
 * It handles event subscription, emission, and optional persistence.
 */
export class EventManager implements EventProcessor {
  private emitter: NodeEventEmitter;
  private logger: Logger;
  private db?: DatabaseManager;
  private options: Required<EventManagerOptions>;
  private eventCounts: Map<EventName, number> = new Map();
  private startTime: number = Date.now();
  
  /**
   * Event statistics for monitoring
   */
  private stats = {
    totalEvents: 0,
    eventsByType: new Map<EventName, number>(),
    errorsInHandlers: 0,
    lastEvent: { type: '', timestamp: 0 },
  };
  
  /**
   * Create a new EventManager
   * @param options Configuration options
   * @param dbManager Optional database manager for event persistence
   */
  constructor(
    options: EventManagerOptions = {},
    dbManager?: DatabaseManager
  ) {
    this.emitter = new NodeEventEmitter();
    this.logger = new Logger('EventManager');
    this.db = dbManager;
    
    // Set default options
    this.options = {
      logToConsole: options.logToConsole ?? true,
      storeEvents: options.storeEvents ?? !!dbManager,
      maxListeners: options.maxListeners ?? 30,
      excludedEvents: options.excludedEvents ?? ['log'],
    };
    
    // Set max listeners
    this.emitter.setMaxListeners(this.options.maxListeners);
    
    // Initialize event counts for all known event types
    const eventTypes: EventName[] = [
      'newPool', 'tradeDecision', 'tradeResult', 'log',
      'positionUpdate', 'systemStatus', 'connectionStatus', 'tokenUpdate',
      'liquidityUpdate', 'walletUpdate', 'notification'
    ];
    
    eventTypes.forEach(event => {
      this.eventCounts.set(event, 0);
    });
    
    // Set up error handling for the event emitter
    this.emitter.on('error', (error) => {
      this.logger.error(`Error in event emitter: ${error instanceof Error ? error.message : String(error)}`);
      this.stats.errorsInHandlers++;
    });
  }
  
  /**
   * Subscribe to an event with a handler function.
   * Returns an unsubscribe function.
   */
  public on<T extends EventName>(event: T, handler: EventHandler<T>): () => void {
    const wrappedHandler = this.wrapHandler(event, handler);
    this.emitter.on(event, wrappedHandler);
    return () => this.off(event, handler);
  }
  
  /**
   * Subscribe to an event for a single occurrence.
   */
  public once<T extends EventName>(event: T, handler: EventHandler<T>): void {
    const wrappedHandler = this.wrapHandler(event, handler);
    this.emitter.once(event, wrappedHandler);
  }
  
  /**
   * Unsubscribe a handler from an event.
   */
  public off<T extends EventName>(event: T, handler: EventHandler<T>): void {
    // We need to find the wrapped handler to remove
    const listeners = this.emitter.listeners(event) as Array<{
      originalHandler?: EventHandler<T>;
      (data: any): void;
    }>;
    
    // Find the wrapped version of this handler by its original function reference
    // stored in a property on the wrapped function
    for (const listener of listeners) {
      if (listener.originalHandler === handler) {
        this.emitter.off(event, listener);
        break;
      }
    }
  }
  
  /**
   * Emit an event with data.
   * @returns true if the event had listeners, false otherwise
   */
  public emit<T extends EventName>(event: T, data: EventMap[T]): boolean {
    this.trackEvent(event);
    
    // Log the event if configured to do so
    this.logEvent(event, data);
    
    // Store the event in the database if configured to do so
    this.storeEvent(event, data);
    
    // Emit the event
    return this.emitter.emit(event, data);
  }
  
  /**
   * Remove all listeners for a specific event or all events.
   */
  public removeAllListeners(event?: EventName): void {
    this.emitter.removeAllListeners(event);
  }
  
  /**
   * Get event statistics
   */
  public getStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    errorsInHandlers: number;
    eventsPerSecond: number;
    lastEvent: { type: string; timestamp: number };
  } {
    const runningTimeSeconds = (Date.now() - this.startTime) / 1000;
    const eventsPerSecond = this.stats.totalEvents / Math.max(1, runningTimeSeconds);
    
    // Convert Map to object for easier serialization
    const eventsByType: Record<string, number> = {};
    this.stats.eventsByType.forEach((count, type) => {
      eventsByType[type] = count;
    });
    
    return {
      totalEvents: this.stats.totalEvents,
      eventsByType,
      errorsInHandlers: this.stats.errorsInHandlers,
      eventsPerSecond,
      lastEvent: this.stats.lastEvent,
    };
  }
  
  /**
   * Reset the event statistics
   */
  public resetStats(): void {
    this.stats.totalEvents = 0;
    this.stats.eventsByType.clear();
    this.stats.errorsInHandlers = 0;
    this.stats.lastEvent = { type: '', timestamp: 0 };
    this.startTime = Date.now();
  }
  
  /**
   * Track an event for statistics
   */
  private trackEvent(event: EventName): void {
    this.stats.totalEvents++;
    
    const currentCount = this.stats.eventsByType.get(event) || 0;
    this.stats.eventsByType.set(event, currentCount + 1);
    
    this.stats.lastEvent = {
      type: event,
      timestamp: Date.now(),
    };
  }
  
  /**
   * Wrap a handler to add error handling and timing
   */
  private wrapHandler<T extends EventName>(
    event: T,
    handler: EventHandler<T>
  ): { (data: EventMap[T]): Promise<void>; originalHandler: EventHandler<T> } {
    // Create a wrapped handler that includes error handling
    const wrappedHandler = async (data: EventMap[T]): Promise<void> => {
      try {
        // Call the original handler - support both sync and async handlers
        const result = handler(data);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        this.stats.errorsInHandlers++;
        this.logger.error(
          `Error in handler for event "${event}": ${error instanceof Error ? error.message : String(error)}`,
          { error, event, data }
        );
      }
    };
    
    // Store a reference to the original handler so we can remove it later
    (wrappedHandler as any).originalHandler = handler;
    
    return wrappedHandler as { (data: EventMap[T]): Promise<void>; originalHandler: EventHandler<T> };
  }
  
  /**
   * Log an event to the console if enabled
   */
  private logEvent<T extends EventName>(event: T, data: EventMap[T]): void {
    if (!this.options.logToConsole || this.options.excludedEvents.includes(event)) {
      return;
    }
    
    // Don't log log events to avoid recursion
    if (event === 'log') {
      return;
    }
    
    this.logger.debug(`Event: ${event}`, { eventData: this.sanitizeEventData(data) });
  }
  
  /**
   * Store an event in the database if enabled
   */
  private async storeEvent<T extends EventName>(event: T, data: EventMap[T]): Promise<void> {
    if (
      !this.options.storeEvents ||
      !this.db ||
      this.options.excludedEvents.includes(event)
    ) {
      return;
    }
    
    try {
      // Skip certain high-frequency events from database storage to prevent bloat
      if (event === 'log') {
        const logEvent = data as unknown as LogEvent;
        
        // Only store error, warning, and success logs
        if (logEvent.level === 'debug' || logEvent.level === 'info') {
          return;
        }
      }
      
      // Convert the event into a LogEvent for the database
      const logEvent: LogEvent = {
        level: event === 'log' ? (data as unknown as LogEvent).level : 'info',
        message: `Event: ${event}`,
        timestamp: 'timestamp' in data ? (data as any).timestamp : Date.now(),
        data: { type: event, ...this.sanitizeEventData(data) },
      };
      
      // Handle specific event types
      if (event === 'systemStatus' || event === 'connectionStatus') {
        logEvent.level = (data as any).status === 'ERROR' ? 'error' : 'info';
      } else if (event === 'tradeResult') {
        const tradeResult = data as unknown as EventMap['tradeResult'];
        logEvent.level = tradeResult.success ? 'success' : 'error';
      } else if (event === 'notification') {
        const notification = data as unknown as EventMap['notification'];
        logEvent.level = notification.level;
        logEvent.message = notification.title;
        logEvent.data = { message: notification.message, ...notification.data };
      }
      
      // Store the event in the database
      await this.db.addLogEvent(logEvent);
    } catch (error) {
      this.logger.warning(
        `Failed to store event in database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  /**
   * Sanitize event data for logging
   * This helps prevent sensitive data from being logged and large objects from bloating logs
   */
  private sanitizeEventData(data: any): any {
    if (typeof data !== 'object' || data === null) {
      return data;
    }
    
    // Create a shallow copy to avoid modifying the original
    const sanitized = { ...data };
    
    // Truncate large string fields
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === 'string' && value.length > 1000) {
        sanitized[key] = `${value.substring(0, 1000)}... [truncated]`;
      } else if (key === 'signature' && typeof value === 'string') {
        // Only show first and last 8 characters of signatures
        sanitized[key] = value.length > 16
          ? `${value.substring(0, 8)}...${value.substring(value.length - 8)}`
          : value;
      }
    }
    
    // Remove potentially sensitive fields
    const sensitiveKeys = ['privateKey', 'secret', 'password'];
    for (const key of sensitiveKeys) {
      if (key in sanitized) {
        sanitized[key] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }
}

/**
 * Create a singleton instance of the EventManager for use throughout the application
 */
export const eventManager = new EventManager();
export default eventManager;