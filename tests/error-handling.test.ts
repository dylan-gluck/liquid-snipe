import { ErrorHandler, ErrorContext } from '../src/core/error-handler';
import { CircuitBreaker, CircuitBreakerRegistry, CircuitBreakerState } from '../src/core/circuit-breaker';
import { NotificationSystem, ConsoleNotificationChannel } from '../src/core/notification-system';
import { EventManager } from '../src/events/event-manager';
import { NotificationEvent } from '../src/events/types';

describe('Error Handling System', () => {
  let eventManager: EventManager;
  let errorHandler: ErrorHandler;

  beforeEach(() => {
    eventManager = new EventManager({ storeEvents: false, logToConsole: false });
    errorHandler = new ErrorHandler(eventManager, {
      maxRetries: 2,
      retryDelay: 100,
      enableNotifications: false,
      enableMetrics: true
    });
  });

  describe('ErrorHandler', () => {
    test('should capture and enrich errors with context', () => {
      const error = new Error('Test error message');
      const context: ErrorContext = {
        component: 'TestComponent',
        operation: 'test-operation',
        metadata: { key: 'value' }
      };

      const enrichedError = errorHandler.captureError(error, context);

      expect(enrichedError.id).toBeDefined();
      expect(enrichedError.originalError).toBe(error);
      expect(enrichedError.context).toBe(context);
      expect(enrichedError.timestamp).toBeGreaterThan(0);
      expect(enrichedError.isRecoverable).toBe(true);
      expect(enrichedError.tags).toContain('TestComponent');
    });

    test('should determine error severity correctly', () => {
      const criticalError = new Error('CRITICAL system failure');
      const context: ErrorContext = {
        component: 'TradeExecutor',
        operation: 'execute-trade'
      };

      const enrichedError = errorHandler.captureError(criticalError, context);

      expect(enrichedError.severity.affectsTrading).toBe(true);
      expect(enrichedError.severity.level).toBe('CRITICAL'); // CRITICAL message makes it CRITICAL level
    });

    test('should identify recoverable vs non-recoverable errors', () => {
      const recoverableError = new Error('Connection timeout');
      const nonRecoverableError = new Error('CRITICAL system error'); // Use CRITICAL to make it non-recoverable
      
      const context: ErrorContext = {
        component: 'ConnectionManager',
        operation: 'connect'
      };

      const recoverable = errorHandler.captureError(recoverableError, context);
      const nonRecoverable = errorHandler.captureError(nonRecoverableError, context);

      expect(recoverable.isRecoverable).toBe(true);
      expect(nonRecoverable.isRecoverable).toBe(false);
    });

    test('should track error metrics', () => {
      const error = new Error('Test error');
      const context: ErrorContext = {
        component: 'TestComponent',
        operation: 'test'
      };

      errorHandler.captureError(error, context);
      errorHandler.captureError(error, context);

      const metrics = errorHandler.getErrorMetrics();
      expect(metrics.totalErrors).toBe(2);
      expect(metrics.errorsByComponent.TestComponent).toBe(2);
    });

    test('should generate appropriate tags', () => {
      const timeoutError = new Error('Connection timeout occurred');
      const context: ErrorContext = {
        component: 'ConnectionManager',
        operation: 'connect'
      };

      const enrichedError = errorHandler.captureError(timeoutError, context);

      expect(enrichedError.tags).toContain('ConnectionManager');
      expect(enrichedError.tags).toContain('timeout');
      // Note: The current implementation uses 'connection' tag for connection-related errors
    });
  });

  describe('CircuitBreaker', () => {
    let circuitBreaker: CircuitBreaker;

    beforeEach(() => {
      circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 100,
        monitoringPeriod: 1000,
        name: 'TestBreaker'
      });
    });

    test('should start in closed state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(circuitBreaker.isRequestAllowed()).toBe(true);
    });

    test('should open after reaching failure threshold', async () => {
      const failingOperation = async () => {
        throw new Error('Operation failed');
      };

      // Execute failing operation multiple times
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failingOperation);
        } catch (error) {
          // Expected to fail
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
      expect(circuitBreaker.isRequestAllowed()).toBe(false);
    });

    test('should transition to half-open after timeout', async () => {
      const failingOperation = async () => {
        throw new Error('Operation failed');
      };

      // Trigger circuit breaker
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failingOperation);
        } catch (error) {
          // Expected to fail
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Next request should transition to half-open
      expect(circuitBreaker.isRequestAllowed()).toBe(true);
    });

    test('should close after successful operations in half-open state', async () => {
      const mockOperation = jest.fn().mockResolvedValue('success');

      // Force to half-open state
      circuitBreaker['setState'](CircuitBreakerState.HALF_OPEN);

      // Execute successful operations
      await circuitBreaker.execute(mockOperation);
      await circuitBreaker.execute(mockOperation);

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    test('should provide accurate statistics', async () => {
      const mockOperation = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('Success');

      try {
        await circuitBreaker.execute(mockOperation);
      } catch (error) {
        // Expected failure
      }

      await circuitBreaker.execute(mockOperation);

      const stats = circuitBreaker.getStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.totalFailures).toBe(1);
      expect(stats.successCount).toBe(1);
    });

    test('should emit events on state changes', (done) => {
      let eventCount = 0;
      
      circuitBreaker.on('stateChange', (event) => {
        eventCount++;
        if (eventCount === 1) {
          expect(event.from).toBe(CircuitBreakerState.CLOSED);
          expect(event.to).toBe(CircuitBreakerState.OPEN);
          done();
        }
      });

      // Trigger state change
      const failingOperation = async () => {
        throw new Error('Fail');
      };

      Promise.all([
        circuitBreaker.execute(failingOperation).catch(() => {}),
        circuitBreaker.execute(failingOperation).catch(() => {}),
        circuitBreaker.execute(failingOperation).catch(() => {})
      ]);
    });
  });

  describe('CircuitBreakerRegistry', () => {
    let registry: CircuitBreakerRegistry;

    beforeEach(() => {
      registry = new CircuitBreakerRegistry();
    });

    test('should create and manage circuit breakers', () => {
      const breaker = registry.getOrCreate('test-service', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      expect(breaker).toBeDefined();
      expect(breaker.getName()).toBe('test-service');
      expect(registry.get('test-service')).toBe(breaker);
    });

    test('should return existing breaker for same name', () => {
      const breaker1 = registry.getOrCreate('test-service', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      const breaker2 = registry.getOrCreate('test-service', {
        failureThreshold: 5, // Different config
        successThreshold: 3,
        timeout: 2000,
        monitoringPeriod: 10000
      });

      expect(breaker1).toBe(breaker2);
    });

    test('should provide overall health statistics', () => {
      const breaker1 = registry.getOrCreate('service1', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      const breaker2 = registry.getOrCreate('service2', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      // Force one breaker to open
      breaker1.forceOpen();

      const health = registry.getOverallHealth();
      expect(health.totalBreakers).toBe(2);
      expect(health.openBreakers).toBe(1);
      expect(health.healthyBreakers).toBe(1);
      expect(health.overallHealthy).toBe(false);
    });

    test('should get breakers by state', () => {
      const breaker1 = registry.getOrCreate('service1', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      const breaker2 = registry.getOrCreate('service2', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
        monitoringPeriod: 5000
      });

      breaker1.forceOpen();

      const openBreakers = registry.getBreakersByState(CircuitBreakerState.OPEN);
      const closedBreakers = registry.getBreakersByState(CircuitBreakerState.CLOSED);

      expect(openBreakers).toHaveLength(1);
      expect(closedBreakers).toHaveLength(1);
      expect(openBreakers[0]).toBe(breaker1);
      expect(closedBreakers[0]).toBe(breaker2);
    });
  });

  describe('NotificationSystem', () => {
    let notificationSystem: NotificationSystem;

    beforeEach(() => {
      notificationSystem = new NotificationSystem(eventManager);
    });

    test('should send notifications through matching rules', async () => {
      const notification: NotificationEvent = {
        id: 'test-1',
        level: 'error',
        title: 'Critical Error',
        message: 'A critical error occurred',
        timestamp: Date.now(),
        urgent: true,
        data: {}
      };

      const result = await notificationSystem.sendNotification(notification);

      expect(result.ruleId).toBe('critical-errors');
      expect(Object.keys(result.channelResults)).toContain('console');
      expect(result.channelResults.console.success).toBe(true);
    });

    test('should respect rate limiting rules', async () => {
      // Add a rule with rate limiting
      notificationSystem.addRule({
        id: 'rate-limited-rule',
        name: 'Rate Limited Rule',
        enabled: true,
        conditions: [
          { field: 'level', operator: 'equals', value: 'info' }
        ],
        channels: ['console'],
        priority: 'LOW',
        maxPerHour: 1
      });

      const notification: NotificationEvent = {
        id: 'test-1',
        level: 'info',
        title: 'Test Notification',
        message: 'Test message',
        timestamp: Date.now(),
        urgent: false,
        data: {}
      };

      // First notification should go through
      const result1 = await notificationSystem.sendNotification(notification);
      expect(result1.ruleId).toBe('rate-limited-rule');

      // Second notification should be rate limited
      const result2 = await notificationSystem.sendNotification({
        ...notification,
        id: 'test-2'
      });
      expect(result2.ruleId).toBeUndefined();
    });

    test('should track notification statistics', async () => {
      const notification: NotificationEvent = {
        id: 'test-1',
        level: 'error', // Use error level to match existing rule
        title: 'Critical Error',
        message: 'A critical error occurred',
        timestamp: Date.now(),
        urgent: true,
        data: {}
      };

      await notificationSystem.sendNotification(notification);

      const stats = notificationSystem.getStats();
      expect(stats.totalSent).toBeGreaterThan(0);
      expect(stats.byLevel.error).toBeGreaterThan(0);
    });

    test('should handle channel failures gracefully', async () => {
      // Add a failing channel
      const failingChannel = {
        name: 'failing-channel',
        enabled: true,
        send: jest.fn().mockRejectedValue(new Error('Channel failed')),
        supports: jest.fn().mockReturnValue(true)
      };

      notificationSystem.addChannel(failingChannel);

      // Add rule that uses the failing channel
      notificationSystem.addRule({
        id: 'failing-rule',
        name: 'Failing Rule',
        enabled: true,
        conditions: [
          { field: 'level', operator: 'equals', value: 'error' }
        ],
        channels: ['failing-channel'],
        priority: 'HIGH'
      });

      const notification: NotificationEvent = {
        id: 'test-1',
        level: 'error',
        title: 'Error',
        message: 'An error occurred',
        timestamp: Date.now(),
        urgent: false,
        data: {}
      };

      const result = await notificationSystem.sendNotification(notification);

      expect(result.channelResults['failing-channel'].success).toBe(false);
      expect(result.channelResults['failing-channel'].error).toBe('Channel failed');
    });

    test('should support test notifications', async () => {
      const result = await notificationSystem.sendTestNotification();

      expect(result.id).toMatch(/^test-/);
      expect(result.level).toBe('info');
      expect(result.title).toBe('Notification System Test');
    });
  });

  describe('Integration Tests', () => {
    test('should handle error through complete error handling pipeline', async () => {
      // Create integrated system
      const testEventManager = new EventManager({ storeEvents: false, logToConsole: false });
      const testErrorHandler = new ErrorHandler(testEventManager, {
        maxRetries: 1,
        retryDelay: 50,
        enableNotifications: false
      });

      const mockError = new Error('Integration test error');
      const context: ErrorContext = {
        component: 'IntegrationTest',
        operation: 'test-operation'
      };

      // Capture error
      const enrichedError = testErrorHandler.captureError(mockError, context);

      // Verify error was captured and enriched
      expect(enrichedError.id).toBeDefined();
      expect(enrichedError.originalError).toBe(mockError);
      expect(enrichedError.context).toBe(context);

      // Verify error is in active errors
      const activeErrors = testErrorHandler.getActiveErrors();
      expect(activeErrors).toHaveLength(1);
      expect(activeErrors[0].id).toBe(enrichedError.id);

      // Verify metrics were updated
      const metrics = testErrorHandler.getErrorMetrics();
      expect(metrics.totalErrors).toBe(1);
      expect(metrics.errorsByComponent.IntegrationTest).toBe(1);
    });
  });
});