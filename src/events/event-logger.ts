import { DatabaseManager } from '../db';
import { LogEvent } from '../types';
import { EventManager } from './event-manager';
import { EventName, EventMap } from './types';

/**
 * Options for configuring the EventLogger
 */
export interface EventLoggerOptions {
  /**
   * Whether to log all events by default
   */
  logAllEvents?: boolean;
  
  /**
   * Specific events to log (if logAllEvents is false)
   */
  eventsToLog?: EventName[];
  
  /**
   * Events to exclude from logging
   */
  excludedEvents?: EventName[];
  
  /**
   * Minimum log level to save
   */
  minLogLevel?: 'debug' | 'info' | 'warning' | 'error';
  
  /**
   * Maximum number of events to keep in memory
   */
  maxEventsInMemory?: number;
}

/**
 * EventLogger links the event system to the database
 * for persistent storage of events.
 */
export class EventLogger {
  private options: Required<EventLoggerOptions>;
  private db: DatabaseManager;
  private eventManager: EventManager;
  private recentEvents: Array<{ event: EventName; data: any; timestamp: number }> = [];
  
  /**
   * Create a new EventLogger
   */
  constructor(
    db: DatabaseManager,
    eventManager: EventManager,
    options: EventLoggerOptions = {}
  ) {
    this.db = db;
    this.eventManager = eventManager;
    
    // Set default options
    this.options = {
      logAllEvents: options.logAllEvents ?? false,
      eventsToLog: options.eventsToLog ?? ['systemStatus', 'tradeResult', 'notification'],
      excludedEvents: options.excludedEvents ?? ['log'],
      minLogLevel: options.minLogLevel ?? 'info',
      maxEventsInMemory: options.maxEventsInMemory ?? 1000,
    };
    
    // Initialize the logger
    this.initialize();
  }
  
  /**
   * Initialize the logger by setting up event subscriptions
   */
  private initialize(): void {
    // Always subscribe to log events
    this.eventManager.on('log', async (logEvent: LogEvent) => {
      await this.handleLogEvent(logEvent);
    });
    
    // Subscribe to all events or specific events based on configuration
    if (this.options.logAllEvents) {
      // Get all event names except excluded ones
      const eventNames: EventName[] = [
        'newPool', 'tradeDecision', 'tradeResult', 'log',
        'positionUpdate', 'systemStatus', 'connectionStatus', 'tokenUpdate',
        'liquidityUpdate', 'walletUpdate', 'notification'
      ];
      for (const eventName of eventNames) {
        if (!this.options.excludedEvents.includes(eventName) && eventName !== 'log') {
          this.subscribeToEvent(eventName);
        }
      }
    } else {
      // Subscribe to specific events
      for (const eventName of this.options.eventsToLog) {
        if (!this.options.excludedEvents.includes(eventName)) {
          this.subscribeToEvent(eventName);
        }
      }
    }
  }
  
  /**
   * Subscribe to an event and handle it
   */
  private subscribeToEvent<T extends EventName>(eventName: T): void {
    this.eventManager.on(eventName, async (data: EventMap[T]) => {
      // Store in memory buffer
      this.storeEventInMemory(eventName, data);
      
      // Store in database
      await this.logEventToDatabase(eventName, data);
    });
  }
  
  /**
   * Handle a log event
   */
  private async handleLogEvent(logEvent: LogEvent): Promise<void> {
    // Skip log levels below the minimum
    const logLevelOrder = { debug: 0, info: 1, warning: 2, error: 3, success: 4 };
    const minLevelValue = logLevelOrder[this.options.minLogLevel];
    const eventLevelValue = logLevelOrder[logEvent.level];
    
    if (eventLevelValue < minLevelValue) {
      return;
    }
    
    // Store in memory buffer
    this.storeEventInMemory('log', logEvent);
    
    // Store in database
    try {
      await this.db.addLogEvent(logEvent);
    } catch (error) {
      console.error('Failed to store log event in database:', error);
    }
  }
  
  /**
   * Store an event in memory for quick access
   */
  private storeEventInMemory<T extends EventName>(event: T, data: any): void {
    this.recentEvents.push({
      event,
      data,
      timestamp: Date.now(),
    });
    
    // Trim the events array if it exceeds the maximum size
    if (this.recentEvents.length > this.options.maxEventsInMemory) {
      this.recentEvents = this.recentEvents.slice(-this.options.maxEventsInMemory);
    }
  }
  
  /**
   * Log an event to the database
   */
  private async logEventToDatabase<T extends EventName>(
    event: T,
    data: EventMap[T]
  ): Promise<void> {
    // Get the timestamp from the data or use current time
    const timestamp = 'timestamp' in data ? (data as any).timestamp : Date.now();
    
    // Determine log level based on event type and data
    let level: LogEvent['level'] = 'info';
    if (event === 'systemStatus' || event === 'connectionStatus') {
      level = (data as any).status === 'ERROR' ? 'error' : 'info';
    } else if (event === 'tradeResult') {
      const tradeResult = data as unknown as EventMap['tradeResult'];
      level = tradeResult.success ? 'success' : 'error';
    } else if (event === 'notification') {
      const notification = data as unknown as EventMap['notification'];
      level = notification.level;
    }
    
    // Create a log event
    const logEvent: LogEvent = {
      level,
      message: `Event: ${event}`,
      timestamp,
      data: { type: event, ...data },
    };
    
    // Store the event in the database
    try {
      await this.db.addLogEvent(logEvent);
    } catch (error) {
      console.error(`Failed to log event to database: ${error}`);
    }
  }
  
  /**
   * Get recent events from memory
   */
  public getRecentEvents(
    limit: number = 100,
    eventType?: EventName
  ): Array<{ event: EventName; data: any; timestamp: number }> {
    let filteredEvents = this.recentEvents;
    
    // Filter by event type if specified
    if (eventType) {
      filteredEvents = filteredEvents.filter(e => e.event === eventType);
    }
    
    // Sort by timestamp (newest first) and limit
    return filteredEvents
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
  
  /**
   * Prune old events from the database
   */
  public async pruneOldEvents(olderThanDays: number): Promise<number> {
    return await this.db.pruneOldLogEvents(olderThanDays);
  }
}

export default EventLogger;