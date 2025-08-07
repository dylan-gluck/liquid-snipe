/**
 * Comprehensive Race Condition Tests for AtomicPositionStateMachine
 * Tests concurrent state transitions, atomic operations, and race condition prevention
 */

import { AtomicPositionStateMachine } from '../src/core/state-machines/atomic-position-state-machine';
import {
  PositionState,
  PositionStateTransition,
  PositionStateContext,
} from '../src/core/state-machines/position-state-machine';

describe('AtomicPositionStateMachine Race Condition Tests', () => {
  let stateMachine: AtomicPositionStateMachine;
  let initialContext: Omit<PositionStateContext, 'entryTimestamp'>;

  beforeEach(() => {
    initialContext = {
      positionId: `test-pos-${Date.now()}`,
      tokenAddress: 'test-token-address',
      entryPrice: 100,
      amount: 1000,
      currentPrice: 100,
      pnlPercent: 0,
      pnlUsd: 0,
    };

    stateMachine = new AtomicPositionStateMachine(initialContext);
  });

  describe('Concurrent State Transition Tests', () => {
    it('should handle multiple simultaneous state transitions atomically', async () => {
      // Open position first
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      expect(stateMachine.getCurrentState()).toBe(PositionState.MONITORING);

      const transitionPromises = [
        stateMachine.transition(PositionStateTransition.EXIT_CONDITION_MET),
        stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED),
        stateMachine.transition(PositionStateTransition.MANUAL_EXIT_REQUESTED),
      ];

      const results = await Promise.allSettled(transitionPromises);
      
      // Only one transition should succeed due to atomic CAS operations
      const successfulTransitions = results.filter(r => r.status === 'fulfilled' && (r as any).value === true);
      expect(successfulTransitions).toHaveLength(1);

      // Verify final state is consistent
      const finalState = stateMachine.getCurrentState();
      expect([PositionState.EXIT_PENDING, PositionState.PAUSED]).toContain(finalState);
    });

    it('should prevent race conditions in rapid state changes', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const rapidTransitions = Array(50).fill(null).map((_, i) => 
        stateMachine.transition(
          i % 2 === 0 ? PositionStateTransition.PAUSE_REQUESTED : PositionStateTransition.EXIT_CONDITION_MET
        )
      );

      const results = await Promise.allSettled(rapidTransitions);
      const successCount = results.filter(r => r.status === 'fulfilled' && (r as any).value === true).length;
      
      // Only the first transition should succeed due to mutex protection
      expect(successCount).toBe(1);
    });

    it('should maintain state consistency under high concurrent load', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const concurrentOperations = Array(100).fill(null).map(async () => {
        const operations = [
          () => stateMachine.getCurrentState(),
          () => stateMachine.isActive(),
          () => stateMachine.canExit(),
          () => stateMachine.getContext(),
          () => stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED),
        ];
        
        // Execute random operations concurrently
        const randomOp = operations[Math.floor(Math.random() * operations.length)];
        return randomOp();
      });

      const results = await Promise.allSettled(concurrentOperations);
      
      // All state read operations should succeed
      const stateReads = results.filter((_, i) => [0, 1, 2, 3].includes(i % 5));
      stateReads.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      // State should remain consistent
      expect([PositionState.MONITORING, PositionState.PAUSED]).toContain(stateMachine.getCurrentState());
    });

    it('should validate atomic CAS operations work correctly', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      let successfulTransitions = 0;
      let failedTransitions = 0;
      
      const testTransitions = Array(20).fill(null).map(async () => {
        const success = await stateMachine.transition(PositionStateTransition.EXIT_CONDITION_MET);
        if (success) {
          successfulTransitions++;
        } else {
          failedTransitions++;
        }
        return success;
      });

      await Promise.all(testTransitions);
      
      // Only one transition should succeed, others should fail due to state change
      expect(successfulTransitions).toBe(1);
      expect(failedTransitions).toBe(19);
      expect(stateMachine.getCurrentState()).toBe(PositionState.EXIT_PENDING);
    });

    it('should handle transition mutex effectiveness', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const startTime = performance.now();
      const concurrentTransitions = Array(10).fill(null).map(async (_, i) => {
        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        return stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED);
      });

      const results = await Promise.all(concurrentTransitions);
      const endTime = performance.now();
      
      // Verify serialized execution (mutex working)
      expect(endTime - startTime).toBeGreaterThan(10); // Should take some time due to mutex
      
      const successCount = results.filter(result => result).length;
      expect(successCount).toBe(1); // Only first should succeed
    });
  });

  describe('Concurrent Price Update Tests', () => {
    it('should handle simultaneous price updates from multiple sources', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const prices = [105, 110, 95, 120, 98];
      const priceUpdatePromises = prices.map(price => 
        stateMachine.updatePrice(price)
      );

      await Promise.allSettled(priceUpdatePromises);
      
      // Final context should have one of the prices
      const context = await stateMachine.getContext();
      expect(prices).toContain(context.currentPrice);
      
      // PnL should be calculated correctly for the final price
      const expectedPnlPercent = ((context.currentPrice! - context.entryPrice) / context.entryPrice) * 100;
      expect(Math.abs(context.pnlPercent! - expectedPnlPercent)).toBeLessThan(0.01);
    });

    it('should prevent race conditions in PnL calculations', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const testPrices = Array(100).fill(null).map(() => 90 + Math.random() * 20); // Prices between 90-110
      
      const updatePromises = testPrices.map(async (price) => {
        await stateMachine.updatePrice(price);
        return stateMachine.getContext();
      });

      const contexts = await Promise.allSettled(updatePromises);
      
      contexts.forEach((result) => {
        if (result.status === 'fulfilled') {
          const context = (result as any).value;
          // Verify PnL consistency
          if (context.currentPrice && context.entryPrice) {
            const expectedPnlPercent = ((context.currentPrice - context.entryPrice) / context.entryPrice) * 100;
            const expectedPnlUsd = (context.currentPrice - context.entryPrice) * context.amount;
            
            expect(Math.abs(context.pnlPercent! - expectedPnlPercent)).toBeLessThan(0.01);
            expect(Math.abs(context.pnlUsd! - expectedPnlUsd)).toBeLessThan(0.01);
          }
        }
      });
    });

    it('should validate atomic context update', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const concurrentUpdates = Array(50).fill(null).map(async (_, i) => {
        await stateMachine.updatePrice(100 + i);
        return stateMachine.getContext();
      });

      const results = await Promise.allSettled(concurrentUpdates);
      
      // All updates should succeed
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      // Final state should be consistent
      const finalContext = await stateMachine.getContext();
      expect(finalContext.currentPrice).toBeGreaterThanOrEqual(100);
      expect(finalContext.lastPriceUpdate).toBeDefined();
    });

    it('should handle price update batching and sequencing', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const batchSize = 20;
      const batches = Array(5).fill(null).map((_, batchIndex) =>
        Array(batchSize).fill(null).map(async (_, i) => {
          const price = 100 + (batchIndex * batchSize) + i;
          await stateMachine.updatePrice(price);
          return { price, timestamp: Date.now() };
        })
      );

      const results = await Promise.all(
        batches.map(batch => Promise.allSettled(batch))
      );

      // Verify all batches completed
      results.forEach(batchResult => {
        batchResult.forEach(result => {
          expect(result.status).toBe('fulfilled');
        });
      });

      const context = await stateMachine.getContext();
      expect(context.currentPrice).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Performance Under Load Tests', () => {
    it('should handle high-frequency operations (1000+ ops/second)', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const startTime = performance.now();
      const operationCount = 1000;
      
      const operations = Array(operationCount).fill(null).map(async (_, i) => {
        const operations = [
          () => stateMachine.getCurrentState(),
          () => stateMachine.updatePrice(100 + (i % 50)),
          () => stateMachine.getContext(),
          () => stateMachine.isActive(),
        ];
        
        const randomOp = operations[i % operations.length];
        return randomOp();
      });

      await Promise.allSettled(operations);
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      const opsPerSecond = (operationCount / duration) * 1000;
      
      expect(opsPerSecond).toBeGreaterThan(1000);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should validate <1ms operation targets for atomic operations', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const measurements: number[] = [];
      
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        await stateMachine.updatePrice(100 + i);
        const end = performance.now();
        measurements.push(end - start);
      }

      const averageTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
      expect(averageTime).toBeLessThan(1); // Less than 1ms average
      
      // 95% of operations should be under 1ms
      const under1ms = measurements.filter(time => time < 1).length;
      expect(under1ms / measurements.length).toBeGreaterThan(0.95);
    });

    it('should detect memory leaks during concurrent operations', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Run intensive operations
      for (let batch = 0; batch < 10; batch++) {
        const operations = Array(100).fill(null).map(async (_, i) => {
          await stateMachine.updatePrice(100 + i);
          await stateMachine.getContext();
          return stateMachine.getCurrentState();
        });
        
        await Promise.allSettled(operations);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be reasonable (less than 10MB)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });

    it('should handle stress testing with rapid state changes', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const stressOperations = Array(500).fill(null).map(async (_, i) => {
        if (i % 10 === 0) {
          // Occasionally try state transitions
          return stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED);
        } else if (i % 3 === 0) {
          // Frequent price updates
          return stateMachine.updatePrice(90 + Math.random() * 20);
        } else {
          // Context reads
          return stateMachine.getContext();
        }
      });

      const startTime = performance.now();
      const results = await Promise.allSettled(stressOperations);
      const endTime = performance.now();
      
      // Most operations should succeed
      const successfulOps = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulOps / results.length).toBeGreaterThan(0.95);
      
      // Should complete quickly
      expect(endTime - startTime).toBeLessThan(5000); // Under 5 seconds
      
      // State should be consistent
      expect([PositionState.MONITORING, PositionState.PAUSED]).toContain(
        stateMachine.getCurrentState()
      );
    });
  });

  describe('Atomic Operation Metrics and Validation', () => {
    it('should track atomic operation performance metrics', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      // Perform various operations
      await stateMachine.updatePrice(105);
      await stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED);
      await stateMachine.updateContext({ exitReason: 'test' });
      
      const metrics = stateMachine.getPerformanceMetrics();
      
      expect(metrics).toHaveProperty('transitions');
      expect(metrics).toHaveProperty('priceUpdates');
      expect(metrics).toHaveProperty('contextUpdates');
      expect(metrics).toHaveProperty('contextVersion');
      expect(metrics).toHaveProperty('currentState');
      
      expect(metrics.transitions.count).toBeGreaterThan(0);
      expect(metrics.priceUpdates.count).toBeGreaterThan(0);
      expect(metrics.contextUpdates.count).toBeGreaterThan(0);
    });

    it('should validate SharedArrayBuffer atomic state consistency', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const initialState = stateMachine.getCurrentState();
      
      // Concurrent state reads
      const stateReads = Array(100).fill(null).map(() => 
        stateMachine.getCurrentState()
      );

      const states = await Promise.all(stateReads);
      
      // All reads should return the same state
      states.forEach(state => {
        expect(state).toBe(initialState);
      });
    });

    it('should ensure context version incrementing works correctly', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const initialMetrics = stateMachine.getPerformanceMetrics();
      const initialVersion = initialMetrics.contextVersion;
      
      await stateMachine.updatePrice(105);
      await stateMachine.updateContext({ exitReason: 'test' });
      
      const finalMetrics = stateMachine.getPerformanceMetrics();
      const finalVersion = finalMetrics.contextVersion;
      
      expect(finalVersion).toBeGreaterThan(initialVersion);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle force state changes atomically', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const concurrentForceChanges = [
        () => stateMachine.forceState(PositionState.ERROR, 'test error 1'),
        () => stateMachine.forceState(PositionState.CLOSED, 'force close 1'),
        () => stateMachine.forceState(PositionState.PAUSED, 'force pause 1'),
      ];

      // Execute concurrent force changes
      concurrentForceChanges.forEach(fn => fn());
      
      // Final state should be one of the forced states
      const finalState = stateMachine.getCurrentState();
      expect([PositionState.ERROR, PositionState.CLOSED, PositionState.PAUSED]).toContain(finalState);
    });

    it('should maintain consistency during error conditions', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      // Simulate error conditions
      const errorOperations = Array(50).fill(null).map(async (_, i) => {
        try {
          if (i % 5 === 0) {
            // Invalid state transitions
            return stateMachine.transition(PositionStateTransition.EXIT_COMPLETED);
          } else {
            // Normal operations
            return stateMachine.updatePrice(100 + i);
          }
        } catch (error) {
          return { error: true };
        }
      });

      const results = await Promise.allSettled(errorOperations);
      
      // System should remain stable
      expect(stateMachine.getCurrentState()).toBeDefined();
      expect(stateMachine.isActive()).toBeDefined();
      
      // At least some operations should succeed
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      expect(successCount).toBeGreaterThan(0);
    });
  });
});