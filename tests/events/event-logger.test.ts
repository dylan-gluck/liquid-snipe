import { EventManager } from '../../src/events/event-manager';
import { EventLogger } from '../../src/events/event-logger';
import { DatabaseManager } from '../../src/db';
import { LogEvent } from '../../src/types';

// Mock the database manager
jest.mock('../../src/db', () => {
  return {
    DatabaseManager: jest.fn().mockImplementation(() => {
      return {
        initialize: jest.fn().mockResolvedValue(undefined),
        addLogEvent: jest.fn().mockResolvedValue(undefined),
        pruneOldLogEvents: jest.fn().mockResolvedValue(10),
      };
    }),
  };
});

describe('EventLogger', () => {
  let eventManager: EventManager;
  let dbManager: jest.Mocked<DatabaseManager>;
  let eventLogger: EventLogger;

  beforeEach(() => {
    // Create a new event manager for each test
    eventManager = new EventManager({
      logToConsole: false,
      storeEvents: false,
    });
    
    // Create a mock database manager
    dbManager = new DatabaseManager('') as jest.Mocked<DatabaseManager>;
    
    // Create the event logger
    eventLogger = new EventLogger(dbManager, eventManager, {
      logAllEvents: false,
      eventsToLog: ['systemStatus', 'tradeResult'],
      maxEventsInMemory: 100,
    });
  });

  afterEach(() => {
    eventManager.removeAllListeners();
    jest.clearAllMocks();
  });

  describe('Log Events', () => {
    it('should log events to the database', () => {
      // Emit a log event
      const logEvent: LogEvent = {
        level: 'info',
        message: 'Test log message',
        timestamp: Date.now(),
      };
      
      eventManager.emit('log', logEvent);
      
      // Check that the database addLogEvent method was called
      expect(dbManager.addLogEvent).toHaveBeenCalledWith(logEvent);
    });

    it('should apply log level filtering', () => {
      // Reset the mock between tests
      (dbManager.addLogEvent as jest.Mock).mockClear();
      
      // Create a new db and event manager for this test to avoid interference
      const testDb = new DatabaseManager('') as jest.Mocked<DatabaseManager>;
      testDb.addLogEvent = jest.fn().mockResolvedValue(undefined);
      
      const testEventManager = new EventManager({
        logToConsole: false,
        storeEvents: false,
      });
      
      // Create a logger with minimum level set to warning
      const filteredLogger = new EventLogger(testDb, testEventManager, {
        minLogLevel: 'warning',
      });
      
      // Emit debug and info log events - these should be filtered out
      const debugLogEvent: LogEvent = {
        level: 'debug',
        message: 'Debug message',
        timestamp: Date.now(),
      };
      
      const infoLogEvent: LogEvent = {
        level: 'info',
        message: 'Info message',
        timestamp: Date.now(),
      };
      
      // Emit warning and error events - these should be logged
      const warningLogEvent: LogEvent = {
        level: 'warning',
        message: 'Warning message',
        timestamp: Date.now(),
      };
      
      const errorLogEvent: LogEvent = {
        level: 'error',
        message: 'Error message',
        timestamp: Date.now(),
      };
      
      testEventManager.emit('log', debugLogEvent);
      testEventManager.emit('log', infoLogEvent);
      testEventManager.emit('log', warningLogEvent);
      testEventManager.emit('log', errorLogEvent);
      
      // Only warning and error should have been logged
      expect(testDb.addLogEvent).toHaveBeenCalledTimes(2);
      expect(testDb.addLogEvent).toHaveBeenCalledWith(warningLogEvent);
      expect(testDb.addLogEvent).toHaveBeenCalledWith(errorLogEvent);
    });
  });

  describe('System Events', () => {
    it('should log system events based on configuration', () => {
      // Emit a system status event
      const systemStatusEvent = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };
      
      eventManager.emit('systemStatus', systemStatusEvent);
      
      // Check that it was logged
      expect(dbManager.addLogEvent).toHaveBeenCalledTimes(1);
      
      // The log event should contain the system status data
      const logEventArg = (dbManager.addLogEvent as jest.Mock).mock.calls[0][0];
      expect(logEventArg.level).toBe('info');
      expect(logEventArg.data).toEqual(expect.objectContaining({
        type: 'systemStatus',
        status: 'READY',
      }));
    });

    it('should log error system events as error level', () => {
      // Emit a system status error event
      const errorEvent = {
        status: 'ERROR' as const,
        reason: 'Something went wrong',
        timestamp: Date.now(),
      };
      
      eventManager.emit('systemStatus', errorEvent);
      
      // Check that it was logged as an error
      const logEventArg = (dbManager.addLogEvent as jest.Mock).mock.calls[0][0];
      expect(logEventArg.level).toBe('error');
    });

    it('should log trade results with appropriate levels', () => {
      // Emit successful trade result
      const successTradeResult = {
        success: true,
        signature: 'tx123',
        tradeId: 'trade1',
        timestamp: Date.now(),
      };
      
      // Emit failed trade result
      const failedTradeResult = {
        success: false,
        error: 'Failed to execute trade',
        timestamp: Date.now(),
      };
      
      eventManager.emit('tradeResult', successTradeResult);
      eventManager.emit('tradeResult', failedTradeResult);
      
      // Check that they were logged with the right levels
      expect(dbManager.addLogEvent).toHaveBeenCalledTimes(2);
      
      const successLogEventArg = (dbManager.addLogEvent as jest.Mock).mock.calls[0][0];
      expect(successLogEventArg.level).toBe('success');
      
      const failedLogEventArg = (dbManager.addLogEvent as jest.Mock).mock.calls[1][0];
      expect(failedLogEventArg.level).toBe('error');
    });
  });

  describe('Memory Event Storage', () => {
    it('should store recent events in memory', () => {
      // Emit several events
      for (let i = 0; i < 10; i++) {
        eventManager.emit('systemStatus', {
          status: 'READY' as const,
          timestamp: Date.now(),
        });
      }
      
      // Get recent events
      const recentEvents = eventLogger.getRecentEvents(5);
      
      // Should have 5 events (limited by parameter)
      expect(recentEvents.length).toBe(5);
      
      // Events should be in reverse order (newest first)
      for (let i = 0; i < recentEvents.length - 1; i++) {
        expect(recentEvents[i].timestamp).toBeGreaterThanOrEqual(recentEvents[i + 1].timestamp);
      }
    });

    it('should respect the maximum events in memory limit', () => {
      // Create a logger with a small memory limit
      const smallLogger = new EventLogger(dbManager, eventManager, {
        maxEventsInMemory: 5,
      });
      
      // Emit enough events to exceed the limit
      for (let i = 0; i < 10; i++) {
        eventManager.emit('log', {
          level: 'info',
          message: `Test message ${i}`,
          timestamp: Date.now() + i,
        });
      }
      
      // Get all recent events
      const recentEvents = smallLogger.getRecentEvents(100);
      
      // Should have been limited to 5 events
      expect(recentEvents.length).toBe(5);
      
      // Should have the most recent 5 events (timestamps 5-9)
      const messages = recentEvents.map(e => (e.data as LogEvent).message);
      expect(messages).toContain('Test message 9');
      expect(messages).toContain('Test message 8');
      expect(messages).toContain('Test message 7');
      expect(messages).toContain('Test message 6');
      expect(messages).toContain('Test message 5');
    });

    it('should filter events by type', () => {
      // Emit different types of events
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      eventManager.emit('connectionStatus', {
        type: 'RPC' as const,
        status: 'CONNECTED' as const,
        timestamp: Date.now(),
      });
      
      // Get only system status events
      const systemEvents = eventLogger.getRecentEvents(100, 'systemStatus');
      
      // Should have only system status events
      expect(systemEvents.length).toBe(1);
      expect(systemEvents[0].event).toBe('systemStatus');
    });
  });

  describe('Event Pruning', () => {
    it('should prune old events from the database', async () => {
      // Call prune method
      const deletedCount = await eventLogger.pruneOldEvents(30);
      
      // Check that the database method was called
      expect(dbManager.pruneOldLogEvents).toHaveBeenCalledWith(30);
      
      // Should return the number of deleted events
      expect(deletedCount).toBe(10);
    });
  });
});