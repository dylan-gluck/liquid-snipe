import { EventManager } from '../../src/events/event-manager';
import { EventName } from '../../src/events/types';

describe('EventManager', () => {
  let eventManager: EventManager;

  beforeEach(() => {
    // Mock console methods to prevent test output pollution
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'info').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();
    
    eventManager = new EventManager({
      logToConsole: false,
      storeEvents: false,
    });
  });

  afterEach(() => {
    eventManager.removeAllListeners();
    jest.restoreAllMocks();
  });

  describe('Basic Event Handling', () => {
    it('should emit and receive events', () => {
      const handler = jest.fn();
      eventManager.on('systemStatus', handler);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      eventManager.emit('systemStatus', eventData);
      expect(handler).toHaveBeenCalledWith(eventData);
    });

    it('should support multiple listeners for the same event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      
      eventManager.on('systemStatus', handler1);
      eventManager.on('systemStatus', handler2);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      eventManager.emit('systemStatus', eventData);
      
      expect(handler1).toHaveBeenCalledWith(eventData);
      expect(handler2).toHaveBeenCalledWith(eventData);
    });

    it('should handle once() subscriptions correctly', () => {
      const handler = jest.fn();
      eventManager.once('systemStatus', handler);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      // First emission should trigger handler
      eventManager.emit('systemStatus', eventData);
      expect(handler).toHaveBeenCalledTimes(1);

      // Second emission should not trigger handler
      eventManager.emit('systemStatus', eventData);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support unsubscribing with the returned function', () => {
      const handler = jest.fn();
      const unsubscribe = eventManager.on('systemStatus', handler);

      // Unsubscribe
      unsubscribe();

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      eventManager.emit('systemStatus', eventData);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should support unsubscribing with off()', () => {
      const handler = jest.fn();
      eventManager.on('systemStatus', handler);

      // Unsubscribe
      eventManager.off('systemStatus', handler);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      eventManager.emit('systemStatus', eventData);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should remove all listeners for a specific event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      
      eventManager.on('systemStatus', handler1);
      eventManager.on('systemStatus', handler2);
      
      // Remove all listeners for the event
      eventManager.removeAllListeners('systemStatus');

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      eventManager.emit('systemStatus', eventData);
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should remove all listeners for all events', () => {
      // We need to directly access the Node.js EventEmitter for this test
      // Create a fresh manager for this test
      const NodeEventEmitter = require('events').EventEmitter;
      const mockEmitter = new NodeEventEmitter();
      
      // Spy on removeAllListeners
      const spy = jest.spyOn(mockEmitter, 'removeAllListeners');
      
      // Create a test class that delegates to our mock
      class TestManager extends EventManager {
        constructor() {
          super({ logToConsole: false, storeEvents: false });
          // Replace the internal emitter with our mock
          (this as any).emitter = mockEmitter;
        }
      }
      
      const testManager = new TestManager();
      
      // Call removeAllListeners
      testManager.removeAllListeners();
      
      // Verify it called the underlying emitter method
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should catch synchronous errors in event handlers', () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Test error');
      });
      
      eventManager.on('systemStatus', errorHandler);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      // This should not throw, even though the handler throws
      expect(() => {
        eventManager.emit('systemStatus', eventData);
      }).not.toThrow();
      
      // Verify the handler was called
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should catch async errors in event handlers', async () => {
      const asyncErrorHandler = jest.fn(async () => {
        throw new Error('Async test error');
      });
      
      eventManager.on('systemStatus', asyncErrorHandler);

      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };

      // This should not throw, even though the handler throws
      eventManager.emit('systemStatus', eventData);
      
      // Wait for the async handler to complete
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify the handler was called
      expect(asyncErrorHandler).toHaveBeenCalled();
    });
  });

  describe('Event Statistics', () => {
    it('should track event statistics', () => {
      // Emit a few events
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      eventManager.emit('connectionStatus', {
        type: 'RPC' as const,
        status: 'CONNECTED' as const,
        timestamp: Date.now(),
      });
      
      eventManager.emit('systemStatus', {
        status: 'ERROR' as const,
        reason: 'Test error',
        timestamp: Date.now(),
      });
      
      // Get stats
      const stats = eventManager.getStats();
      
      // Check overall stats
      expect(stats.totalEvents).toBe(3);
      expect(stats.eventsByType.systemStatus).toBe(2);
      expect(stats.eventsByType.connectionStatus).toBe(1);
      expect(stats.errorsInHandlers).toBe(0);
      
      // Last event should be the system status error
      expect(stats.lastEvent.type).toBe('systemStatus');
    });

    it('should reset stats correctly', () => {
      // Emit some events
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      // Reset stats
      eventManager.resetStats();
      
      // Get stats
      const stats = eventManager.getStats();
      
      // Stats should be reset
      expect(stats.totalEvents).toBe(0);
      expect(Object.keys(stats.eventsByType).length).toBe(0);
      expect(stats.errorsInHandlers).toBe(0);
    });
  });

  describe('Type Safety', () => {
    it('should enforce type safety for event payloads', () => {
      // This test is more about TypeScript compilation than runtime behavior
      // We're testing that the types are correct by attempting to emit invalid payloads
      
      // Valid payload - should compile
      eventManager.emit('systemStatus', {
        status: 'READY' as const,
        timestamp: Date.now(),
      });
      
      // TypeScript should catch these errors at compile time
      // @ts-expect-error - Missing required fields
      eventManager.emit('systemStatus', {});
      
      // This would cause a TypeScript error at compile time
      (eventManager as any).emit('systemStatus', {
        status: 'INVALID_STATUS',
        timestamp: Date.now(),
      });
      
      // @ts-expect-error - Wrong event type
      eventManager.emit('invalidEventType', {});
    });
  });

  describe('Event Handler Types', () => {
    it('should support both synchronous and asynchronous handlers', async () => {
      // Synchronous handler
      const syncHandler = jest.fn(() => {
        // Return void
      });
      
      // Asynchronous handler
      const asyncHandler = jest.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        // Return void
      });
      
      eventManager.on('systemStatus', syncHandler);
      eventManager.on('systemStatus', asyncHandler);
      
      const eventData = {
        status: 'READY' as const,
        timestamp: Date.now(),
      };
      
      eventManager.emit('systemStatus', eventData);
      
      // Both handlers should have been called
      expect(syncHandler).toHaveBeenCalledWith(eventData);
      expect(asyncHandler).toHaveBeenCalledWith(eventData);
      
      // Wait for async handler to complete
      await new Promise(resolve => setTimeout(resolve, 20));
      
      // Verify both handlers were called
      expect(syncHandler).toHaveReturned();
      expect(asyncHandler).toHaveReturned();
    });
  });
});