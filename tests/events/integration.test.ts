import { EventManager } from '../../src/events/event-manager';
import { EventLogger } from '../../src/events/event-logger';
import { NotificationBroadcaster } from '../../src/events/notification-broadcaster';
import { DatabaseManager } from '../../src/db';

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

describe('Event System Integration', () => {
  let eventManager: EventManager;
  let dbManager: jest.Mocked<DatabaseManager>;
  let eventLogger: EventLogger;
  let notificationBroadcaster: NotificationBroadcaster;

  beforeEach(() => {
    // Mock console methods to prevent test output pollution
    jest.spyOn(console, 'info').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
    
    // Create the event manager
    eventManager = new EventManager({
      logToConsole: false,
      storeEvents: false,
    });
    
    // Create the database manager
    dbManager = new DatabaseManager('') as jest.Mocked<DatabaseManager>;
    
    // Create the event logger
    eventLogger = new EventLogger(dbManager, eventManager, {
      logAllEvents: true,
      excludedEvents: ['log'],
    });
    
    // Create the notification broadcaster
    notificationBroadcaster = new NotificationBroadcaster(eventManager);
  });

  afterEach(() => {
    eventManager.removeAllListeners();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('End-to-End Event Flow', () => {
    it('should process events through the entire system', async () => {
      // Create a component that emits events
      const mockTrader = {
        executeTrade: () => {
          // Emit a trade result
          eventManager.emit('tradeResult', {
            success: true,
            signature: 'tx123',
            tradeId: 'trade1',
            positionId: 'position1',
            actualAmountOut: 100,
            timestamp: Date.now(),
          });
        }
      };
      
      // Create a component that listens for events
      const mockPositionManager = {
        onTradeResult: jest.fn(),
      };
      
      // Subscribe to trade results
      eventManager.on('tradeResult', mockPositionManager.onTradeResult);
      
      // Execute a trade
      mockTrader.executeTrade();
      
      // Verify the position manager received the event
      expect(mockPositionManager.onTradeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          signature: 'tx123',
          tradeId: 'trade1',
        })
      );
      
      // Verify the event was logged to the database
      expect(dbManager.addLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'success',
          data: expect.objectContaining({
            type: 'tradeResult',
            success: true,
          }),
        })
      );
    });
  });

  describe('System Notification Flow', () => {
    it('should process notifications through the system', async () => {
      // Create a component that generates notifications
      const mockWatcher = {
        notifyNewPool: () => {
          // Use the notification broadcaster
          notificationBroadcaster.notify(
            'success',
            'New Pool Detected',
            'A new pool was detected for token ABC-123',
            { tokenAddress: 'ABC-123', poolAddress: 'POOL-456' },
            ['console']
          );
        }
      };
      
      // Execute the notification
      mockWatcher.notifyNewPool();
      
      // Verify console was called
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('New Pool Detected: A new pool was detected')
      );
      
      // Verify the notification was logged to the database
      expect(dbManager.addLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'success',
          data: expect.objectContaining({
            type: 'notification',
            title: 'New Pool Detected',
          })
        })
      );
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle errors in event handlers', async () => {
      // Create a handler that throws an error
      const errorHandler = jest.fn().mockImplementation(() => {
        throw new Error('Test error in handler');
      });
      
      // Subscribe to system status events
      eventManager.on('systemStatus', errorHandler);
      
      // Emit a system status event
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      // Verify the handler was called
      expect(errorHandler).toHaveBeenCalled();
      
      // Error shouldn't affect other handlers
      const successHandler = jest.fn();
      eventManager.on('systemStatus', successHandler);
      
      // Emit another event
      eventManager.emit('systemStatus', {
        status: 'PAUSED' as const,
        timestamp: Date.now(),
      });
      
      // Both handlers should be called
      expect(errorHandler).toHaveBeenCalledTimes(2);
      expect(successHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in database operations', async () => {
      // Make the database operation fail
      dbManager.addLogEvent.mockRejectedValueOnce(new Error('Database error'));
      
      // Emit an event
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      // The error should be caught and not propagate
      // This is a bit hard to test directly, but we can verify the system is still functional
      
      // Emit another event
      eventManager.emit('systemStatus', {
        status: 'PAUSED' as const,
        timestamp: Date.now(),
      });
      
      // The database should have been called twice
      expect(dbManager.addLogEvent).toHaveBeenCalledTimes(2);
    });
  });
});