/**
 * Atomic Performance and Stress Tests
 * Performance validation and stress testing for atomic implementations
 * Validates <1ms operation targets and handles 100+ concurrent positions
 */

import { AtomicPositionStateMachine } from '../src/core/state-machines/atomic-position-state-machine';
import { AtomicPositionManager } from '../src/trading/atomic-position-manager';
import {
  PositionState,
  PositionStateTransition,
} from '../src/core/state-machines/position-state-machine';

// Performance test configuration
const PERFORMANCE_TARGETS = {
  ATOMIC_OPERATION_MAX_TIME: 1, // <1ms target
  HIGH_FREQUENCY_OPS_PER_SECOND: 1000,
  STRESS_TEST_POSITION_COUNT: 100,
  MEMORY_LEAK_THRESHOLD_MB: 50,
  CONCURRENT_OPERATION_COUNT: 500,
};

// Mock dependencies
const mockDbManager = {
  positions: {
    create: jest.fn().mockResolvedValue({ id: 'perf-test-position' }),
    updateStatus: jest.fn().mockResolvedValue(true),
  },
} as any;

const mockEventProcessor = {
  emit: jest.fn(),
  on: jest.fn(),
} as any;

describe('Atomic Performance and Stress Tests', () => {
  describe('Atomic Operation Performance', () => {
    let stateMachine: AtomicPositionStateMachine;

    beforeEach(() => {
      stateMachine = new AtomicPositionStateMachine({
        positionId: 'perf-test-1',
        tokenAddress: 'perf-token',
        entryPrice: 100,
        amount: 1000,
      });
    });

    it('should achieve <1ms atomic state transitions', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const measurements: number[] = [];
      
      // Measure transition performance
      for (let i = 0; i < 100; i++) {
        // Reset to monitoring state
        if (i > 0) {
          stateMachine.forceState(PositionState.MONITORING, 'performance test reset');
        }
        
        const start = performance.now();
        await stateMachine.transition(PositionStateTransition.PAUSE_REQUESTED);
        const end = performance.now();
        
        measurements.push(end - start);
        
        // Reset for next iteration
        stateMachine.forceState(PositionState.MONITORING, 'performance test reset');
      }

      const averageTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
      const maxTime = Math.max(...measurements);
      const percentile95 = measurements.sort((a, b) => a - b)[Math.floor(measurements.length * 0.95)];

      expect(averageTime).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME);
      expect(percentile95).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME * 2);
      
      console.log(`State transition performance: avg=${averageTime.toFixed(3)}ms, max=${maxTime.toFixed(3)}ms, 95th=${percentile95.toFixed(3)}ms`);
    });

    it('should achieve <1ms atomic price updates', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const measurements: number[] = [];
      
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        await stateMachine.updatePrice(100 + (i % 50));
        const end = performance.now();
        
        measurements.push(end - start);
      }

      const averageTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
      const maxTime = Math.max(...measurements);
      const under1ms = measurements.filter(time => time < PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME).length;

      expect(averageTime).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME);
      expect(under1ms / measurements.length).toBeGreaterThan(0.9); // 90% under 1ms
      
      console.log(`Price update performance: avg=${averageTime.toFixed(3)}ms, max=${maxTime.toFixed(3)}ms, under1ms=${((under1ms/measurements.length)*100).toFixed(1)}%`);
    });

    it('should achieve <1ms atomic context updates', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const measurements: number[] = [];
      
      for (let i = 0; i < 150; i++) {
        const start = performance.now();
        await stateMachine.updateContext({
          exitReason: `performance-test-${i}`,
          pnlPercent: i * 0.1,
          lastPriceUpdate: Date.now(),
        });
        const end = performance.now();
        
        measurements.push(end - start);
      }

      const averageTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
      const percentile99 = measurements.sort((a, b) => a - b)[Math.floor(measurements.length * 0.99)];

      expect(averageTime).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME);
      expect(percentile99).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME * 3);
      
      console.log(`Context update performance: avg=${averageTime.toFixed(3)}ms, 99th=${percentile99.toFixed(3)}ms`);
    });

    it('should maintain performance under concurrent load', async () => {
      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const concurrentOps = 100;
      const operationPromises: Promise<number>[] = [];

      for (let i = 0; i < concurrentOps; i++) {
        const promise = (async () => {
          const start = performance.now();
          
          if (i % 3 === 0) {
            await stateMachine.updatePrice(100 + (i % 20));
          } else if (i % 3 === 1) {
            await stateMachine.updateContext({ pnlPercent: i * 0.1 });
          } else {
            stateMachine.getCurrentState();
            await stateMachine.getContext();
          }
          
          return performance.now() - start;
        })();
        
        operationPromises.push(promise);
      }

      const results = await Promise.all(operationPromises);
      const averageTime = results.reduce((a, b) => a + b, 0) / results.length;
      const maxTime = Math.max(...results);

      // Performance should degrade gracefully under load
      expect(averageTime).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME * 5);
      expect(maxTime).toBeLessThan(PERFORMANCE_TARGETS.ATOMIC_OPERATION_MAX_TIME * 10);
      
      console.log(`Concurrent load performance: avg=${averageTime.toFixed(3)}ms, max=${maxTime.toFixed(3)}ms`);
    });
  });

  describe('High-Frequency Operations', () => {
    let positionManager: AtomicPositionManager;

    beforeEach(() => {
      positionManager = new AtomicPositionManager(mockDbManager, mockEventProcessor, 50);
    });

    it('should handle 1000+ operations per second', async () => {
      // Create base positions
      await Promise.all(
        Array(10).fill(null).map((_, i) =>
          positionManager.createPosition(`hf-token-${i}`, 100, 1000, [])
        )
      );

      const operationCount = 1200;
      const startTime = performance.now();
      
      const operations = Array(operationCount).fill(null).map((_, i) => {
        const opType = i % 5;
        
        switch (opType) {
          case 0:
            return positionManager.updatePricesAtomically([{
              tokenAddress: `hf-token-${i % 10}`,
              price: 95 + (i % 20),
              timestamp: Date.now(),
              source: `hf-test-${i}`,
            }]);
          
          case 1:
            return positionManager.getActivePositions();
          
          case 2:
            return positionManager.evaluateExitConditions();
          
          case 3:
            return positionManager.getPerformanceMetrics();
          
          case 4:
            return positionManager.getPosition(`hf-token-${i % 10}`);
          
          default:
            return Promise.resolve();
        }
      });

      const results = await Promise.allSettled(operations);
      const endTime = performance.now();
      
      const duration = (endTime - startTime) / 1000; // Convert to seconds
      const actualOpsPerSecond = operationCount / duration;
      
      expect(actualOpsPerSecond).toBeGreaterThan(PERFORMANCE_TARGETS.HIGH_FREQUENCY_OPS_PER_SECOND);
      
      const successRate = results.filter(r => r.status === 'fulfilled').length / results.length;
      expect(successRate).toBeGreaterThan(0.95);
      
      console.log(`High-frequency performance: ${actualOpsPerSecond.toFixed(0)} ops/sec, success rate: ${(successRate*100).toFixed(1)}%`);
    });

    it('should maintain throughput under sustained load', async () => {
      // Create positions
      await Promise.all(
        Array(20).fill(null).map((_, i) =>
          positionManager.createPosition(`sustained-token-${i}`, 100, 1000, [])
        )
      );

      const testDuration = 5000; // 5 seconds
      const batchSize = 100;
      let totalOperations = 0;
      let successfulOperations = 0;
      
      const startTime = performance.now();
      
      while (performance.now() - startTime < testDuration) {
        const batchPromises = Array(batchSize).fill(null).map((_, i) => 
          positionManager.updatePricesAtomically([{
            tokenAddress: `sustained-token-${totalOperations % 20}`,
            price: 90 + Math.random() * 20,
            timestamp: Date.now(),
            source: `sustained-${totalOperations}`,
          }])
        );
        
        const batchResults = await Promise.allSettled(batchPromises);
        totalOperations += batchSize;
        successfulOperations += batchResults.filter(r => r.status === 'fulfilled').length;
      }
      
      const actualDuration = (performance.now() - startTime) / 1000;
      const sustainedOpsPerSecond = totalOperations / actualDuration;
      const sustainedSuccessRate = successfulOperations / totalOperations;
      
      expect(sustainedOpsPerSecond).toBeGreaterThan(PERFORMANCE_TARGETS.HIGH_FREQUENCY_OPS_PER_SECOND * 0.8);
      expect(sustainedSuccessRate).toBeGreaterThan(0.9);
      
      console.log(`Sustained load: ${sustainedOpsPerSecond.toFixed(0)} ops/sec over ${actualDuration.toFixed(1)}s`);
    });
  });

  describe('Stress Testing with 100+ Positions', () => {
    let positionManager: AtomicPositionManager;

    beforeEach(() => {
      positionManager = new AtomicPositionManager(mockDbManager, mockEventProcessor, 100);
    });

    it('should handle 100+ concurrent positions', async () => {
      const positionCount = PERFORMANCE_TARGETS.STRESS_TEST_POSITION_COUNT;
      const tokenCount = 25; // 4 positions per token on average
      
      const startTime = performance.now();
      
      // Create positions in batches for better performance
      const batchSize = 20;
      const batches = Math.ceil(positionCount / batchSize);
      
      for (let batch = 0; batch < batches; batch++) {
        const batchPromises = Array(Math.min(batchSize, positionCount - batch * batchSize))
          .fill(null)
          .map((_, i) => {
            const positionIndex = batch * batchSize + i;
            return positionManager.createPosition(
              `stress-token-${positionIndex % tokenCount}`,
              100 + positionIndex,
              1000,
              []
            );
          });
        
        await Promise.all(batchPromises);
      }
      
      const creationTime = performance.now() - startTime;
      
      const activePositions = await positionManager.getActivePositions();
      expect(activePositions.length).toBe(positionCount);
      
      console.log(`Created ${positionCount} positions in ${creationTime.toFixed(0)}ms`);
      
      // Test operations with all positions
      const operationStartTime = performance.now();
      
      // Batch price updates
      const priceUpdates = Array(tokenCount).fill(null).map((_, i) => ({
        tokenAddress: `stress-token-${i}`,
        price: 90 + Math.random() * 40,
        timestamp: Date.now(),
        source: 'stress-test',
      }));
      
      const updateResults = await positionManager.updatePricesAtomically(priceUpdates);
      const operationTime = performance.now() - operationStartTime;
      
      expect(updateResults.length).toBe(positionCount);
      expect(operationTime).toBeLessThan(5000); // Under 5 seconds
      
      console.log(`Updated ${positionCount} positions in ${operationTime.toFixed(0)}ms`);
    });

    it('should maintain performance with large-scale operations', async () => {
      // Create large number of positions
      const positions = await Promise.all(
        Array(150).fill(null).map((_, i) =>
          positionManager.createPosition(`scale-token-${i % 30}`, 100 + i, 1000, [])
        )
      );

      expect(positions.length).toBe(150);

      // Large-scale concurrent operations
      const largeScaleOps = Array(300).fill(null).map((_, i) => {
        const operations = [
          () => positionManager.updatePricesAtomically([{
            tokenAddress: `scale-token-${i % 30}`,
            price: 80 + Math.random() * 40,
            timestamp: Date.now(),
            source: `scale-${i}`,
          }]),
          () => positionManager.evaluateExitConditions(),
          () => positionManager.getActivePositions(),
        ];

        return operations[i % operations.length]();
      });

      const startTime = performance.now();
      const results = await Promise.allSettled(largeScaleOps);
      const endTime = performance.now();
      
      const successRate = results.filter(r => r.status === 'fulfilled').length / results.length;
      const totalTime = endTime - startTime;
      
      expect(successRate).toBeGreaterThan(0.85);
      expect(totalTime).toBeLessThan(15000); // Under 15 seconds
      
      console.log(`Large-scale ops: ${successRate * 100}% success in ${totalTime}ms`);
    });

    it('should handle extreme concurrent load', async () => {
      // Create base positions
      await Promise.all(
        Array(50).fill(null).map((_, i) =>
          positionManager.createPosition(`extreme-token-${i % 10}`, 100, 1000, [])
        )
      );

      const extremeOps = PERFORMANCE_TARGETS.CONCURRENT_OPERATION_COUNT;
      
      const operations = Array(extremeOps).fill(null).map((_, i) => {
        const opTypes = [
          () => positionManager.updatePricesAtomically([{
            tokenAddress: `extreme-token-${i % 10}`,
            price: 50 + Math.random() * 100,
            timestamp: Date.now(),
            source: `extreme-${i}`,
          }]),
          () => positionManager.getActivePositions(),
          () => positionManager.evaluateExitConditions(),
          () => positionManager.getPerformanceMetrics(),
        ];

        return opTypes[i % opTypes.length]();
      });

      const startTime = performance.now();
      const results = await Promise.allSettled(operations);
      const endTime = performance.now();
      
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      const successRate = successCount / extremeOps;
      const opsPerSecond = (extremeOps / (endTime - startTime)) * 1000;
      
      // Should handle extreme load gracefully
      expect(successRate).toBeGreaterThan(0.7); // At least 70% success under extreme load
      expect(opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
      
      console.log(`Extreme load: ${opsPerSecond.toFixed(0)} ops/sec, ${(successRate*100).toFixed(1)}% success`);
    });
  });

  describe('Memory Management and Leak Detection', () => {
    it('should prevent memory leaks during intensive operations', async () => {
      const positionManager = new AtomicPositionManager(mockDbManager, mockEventProcessor);
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Run intensive memory test cycles
      for (let cycle = 0; cycle < 20; cycle++) {
        // Create positions
        const positions = await Promise.all(
          Array(25).fill(null).map((_, i) =>
            positionManager.createPosition(`memory-token-${i}`, 100 + i, 1000, [])
          )
        );

        // Intensive operations on positions
        for (let batch = 0; batch < 10; batch++) {
          await positionManager.updatePricesAtomically(
            positions.slice(0, 10).map((_, i) => ({
              tokenAddress: `memory-token-${i}`,
              price: 90 + Math.random() * 20,
              timestamp: Date.now(),
              source: `memory-cycle-${cycle}-batch-${batch}`,
            }))
          );
        }

        // Close positions
        await Promise.all(
          positions.map(id => positionManager.closePosition(id, `memory cleanup cycle ${cycle}`))
        );

        // Cleanup
        await positionManager.cleanupClosedPositions();
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
        
        // Check memory usage periodically
        if (cycle % 5 === 0) {
          const currentMemory = process.memoryUsage().heapUsed;
          const memoryIncrease = (currentMemory - initialMemory) / (1024 * 1024);
          
          if (memoryIncrease > PERFORMANCE_TARGETS.MEMORY_LEAK_THRESHOLD_MB) {
            console.warn(`Memory increase detected: ${memoryIncrease.toFixed(2)}MB at cycle ${cycle}`);
          }
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const totalMemoryIncrease = (finalMemory - initialMemory) / (1024 * 1024);
      
      expect(totalMemoryIncrease).toBeLessThan(PERFORMANCE_TARGETS.MEMORY_LEAK_THRESHOLD_MB);
      
      console.log(`Memory test completed: ${totalMemoryIncrease.toFixed(2)}MB increase`);
    });

    it('should handle garbage collection pressure gracefully', async () => {
      const stateMachine = new AtomicPositionStateMachine({
        positionId: 'gc-test',
        tokenAddress: 'gc-token',
        entryPrice: 100,
        amount: 1000,
      });

      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const gcTestOps = 2000;
      let successfulOps = 0;
      
      const startTime = performance.now();
      
      for (let i = 0; i < gcTestOps; i++) {
        try {
          // Create memory pressure
          const tempData = Array(1000).fill(null).map(() => ({ data: Math.random() }));
          
          // Perform atomic operations
          await stateMachine.updatePrice(100 + (i % 100));
          await stateMachine.updateContext({ 
            exitReason: `gc-test-${i}`,
            pnlPercent: i * 0.01,
          });
          
          successfulOps++;
          
          // Trigger GC periodically if available
          if (i % 100 === 0 && global.gc) {
            global.gc();
          }
          
        } catch (error) {
          console.warn(`Operation failed at iteration ${i}:`, error);
        }
      }
      
      const endTime = performance.now();
      const successRate = successfulOps / gcTestOps;
      const avgTimePerOp = (endTime - startTime) / gcTestOps;
      
      expect(successRate).toBeGreaterThan(0.95);
      expect(avgTimePerOp).toBeLessThan(5); // Should maintain reasonable performance
      
      console.log(`GC pressure test: ${(successRate*100).toFixed(1)}% success, ${avgTimePerOp.toFixed(2)}ms avg`);
    });
  });

  describe('Performance Benchmarking', () => {
    it('should provide comprehensive performance benchmarks', async () => {
      const positionManager = new AtomicPositionManager(mockDbManager, mockEventProcessor);
      
      const benchmarks = {
        positionCreation: { times: [], operations: 50 },
        priceUpdates: { times: [], operations: 200 },
        exitEvaluation: { times: [], operations: 100 },
        contextUpdates: { times: [], operations: 150 },
      };

      // Create test positions
      const positions = await Promise.all(
        Array(20).fill(null).map((_, i) =>
          positionManager.createPosition(`bench-token-${i}`, 100, 1000, [])
        )
      );

      // Benchmark position creation
      for (let i = 0; i < benchmarks.positionCreation.operations; i++) {
        const start = performance.now();
        await positionManager.createPosition(`bench-create-${i}`, 100 + i, 1000, []);
        benchmarks.positionCreation.times.push(performance.now() - start);
      }

      // Benchmark price updates
      for (let i = 0; i < benchmarks.priceUpdates.operations; i++) {
        const start = performance.now();
        await positionManager.updatePricesAtomically([{
          tokenAddress: `bench-token-${i % 20}`,
          price: 95 + Math.random() * 10,
          timestamp: Date.now(),
          source: `benchmark-${i}`,
        }]);
        benchmarks.priceUpdates.times.push(performance.now() - start);
      }

      // Benchmark exit evaluation
      for (let i = 0; i < benchmarks.exitEvaluation.operations; i++) {
        const start = performance.now();
        await positionManager.evaluateExitConditions();
        benchmarks.exitEvaluation.times.push(performance.now() - start);
      }

      // Calculate and validate benchmarks
      Object.entries(benchmarks).forEach(([operation, data]) => {
        const times = data.times;
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        const p95 = times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
        
        console.log(`${operation}: avg=${avg.toFixed(2)}ms, min=${min.toFixed(2)}ms, max=${max.toFixed(2)}ms, p95=${p95.toFixed(2)}ms`);
        
        // Performance expectations
        expect(avg).toBeLessThan(10); // Average under 10ms
        expect(p95).toBeLessThan(20); // 95th percentile under 20ms
      });

      // Overall system metrics
      const systemMetrics = positionManager.getPerformanceMetrics();
      expect(systemMetrics.totalPositions).toBeGreaterThan(70);
      
      console.log('System Performance Metrics:', {
        totalPositions: systemMetrics.totalPositions,
        activePositions: systemMetrics.activePositions,
        operations: systemMetrics.operations,
      });
    });

    it('should validate performance regression protection', async () => {
      const stateMachine = new AtomicPositionStateMachine({
        positionId: 'regression-perf-test',
        tokenAddress: 'regression-token',
        entryPrice: 100,
        amount: 1000,
      });

      await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
      
      const baselineOps = 100;
      const regressionOps = 1000;
      
      // Establish baseline
      const baselineTimes: number[] = [];
      for (let i = 0; i < baselineOps; i++) {
        const start = performance.now();
        await stateMachine.updatePrice(100 + i);
        baselineTimes.push(performance.now() - start);
      }
      
      const baselineAvg = baselineTimes.reduce((a, b) => a + b, 0) / baselineTimes.length;
      
      // Test for regression under load
      const regressionTimes: number[] = [];
      for (let i = 0; i < regressionOps; i++) {
        const start = performance.now();
        await stateMachine.updatePrice(100 + i);
        regressionTimes.push(performance.now() - start);
      }
      
      const regressionAvg = regressionTimes.reduce((a, b) => a + b, 0) / regressionTimes.length;
      
      // Performance should not regress significantly
      const performanceRatio = regressionAvg / baselineAvg;
      expect(performanceRatio).toBeLessThan(3); // No more than 3x slower
      
      console.log(`Performance regression test: baseline=${baselineAvg.toFixed(3)}ms, regression=${regressionAvg.toFixed(3)}ms, ratio=${performanceRatio.toFixed(2)}x`);
    });
  });
});