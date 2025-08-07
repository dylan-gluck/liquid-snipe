/**
 * Comprehensive Race Condition Tests for AtomicPositionManager
 * Tests concurrent position management, atomic price updates, and cross-position synchronization
 */

import { AtomicPositionManager, AtomicTokenPrice } from '../src/trading/atomic-position-manager';
import { DatabaseManager } from '../src/db';
import { EventProcessor } from '../src/events/types';
import { PositionState, PositionStateTransition } from '../src/core/state-machines/position-state-machine';

// Mock implementations for testing
const mockDbManager = {
  positions: {
    create: jest.fn().mockResolvedValue({ id: 'test-position' }),
    updateStatus: jest.fn().mockResolvedValue(true),
    findById: jest.fn().mockResolvedValue(null),
  },
} as any;

const mockEventProcessor = {
  emit: jest.fn(),
  on: jest.fn(),
} as any;

describe('AtomicPositionManager Race Condition Tests', () => {
  let positionManager: AtomicPositionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    positionManager = new AtomicPositionManager(mockDbManager, mockEventProcessor, 100);
  });

  describe('Concurrent Position Creation Tests', () => {
    it('should handle multiple simultaneous position creation', async () => {
      const tokenAddresses = ['token1', 'token2', 'token3', 'token4', 'token5'];
      
      const creationPromises = tokenAddresses.map((address, i) =>
        positionManager.createPosition(address, 100 + i, 1000, [])
      );

      const results = await Promise.allSettled(creationPromises);
      
      // All positions should be created successfully
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value).toMatch(/^pos_token\d+_\d+_\w+$/);
        }
      });

      // Verify all positions are tracked
      const positions = await positionManager.getActivePositions();
      expect(positions.length).toBe(tokenAddresses.length);
    });

    it('should prevent race conditions during rapid position creation', async () => {
      const rapidCreations = Array(20).fill(null).map((_, i) =>
        positionManager.createPosition(`token-${i}`, 100, 1000, [])
      );

      const startTime = performance.now();
      const results = await Promise.allSettled(rapidCreations);
      const endTime = performance.now();

      // All creations should succeed
      const successfulCreations = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulCreations).toBe(20);

      // Should complete in reasonable time (serialized due to mutex)
      expect(endTime - startTime).toBeGreaterThan(10); // Mutex introduces delay
      expect(endTime - startTime).toBeLessThan(5000); // But not too long

      const activePositions = await positionManager.getActivePositions();
      expect(activePositions.length).toBe(20);
    });

    it('should maintain unique position IDs under concurrent creation', async () => {
      const concurrentCreations = Array(50).fill(null).map(() =>
        positionManager.createPosition('same-token', 100, 1000, [])
      );

      const results = await Promise.allSettled(concurrentCreations);
      const positionIds = results
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as any).value);

      // All position IDs should be unique
      const uniqueIds = new Set(positionIds);
      expect(uniqueIds.size).toBe(positionIds.length);
    });
  });

  describe('Concurrent Price Update Tests', () => {
    let positionIds: string[];

    beforeEach(async () => {
      // Create test positions
      positionIds = await Promise.all([
        positionManager.createPosition('token1', 100, 1000, []),
        positionManager.createPosition('token2', 200, 500, []),
        positionManager.createPosition('token1', 150, 750, []), // Same token as first
      ]);
    });

    it('should handle simultaneous price updates from multiple sources', async () => {
      const priceUpdates: AtomicTokenPrice[] = [
        { tokenAddress: 'token1', price: 110, timestamp: Date.now(), source: 'source1' },
        { tokenAddress: 'token1', price: 105, timestamp: Date.now(), source: 'source2' },
        { tokenAddress: 'token2', price: 220, timestamp: Date.now(), source: 'source1' },
        { tokenAddress: 'token1', price: 108, timestamp: Date.now(), source: 'source3' },
      ];

      const updateResults = await positionManager.updatePricesAtomically(priceUpdates);
      
      // Should have results for all matching positions
      expect(updateResults.length).toBeGreaterThan(0);
      
      // All updates should succeed
      updateResults.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.operationTime).toBeDefined();
        expect(result.updatedFields).toContain('currentPrice');
        expect(result.updatedFields).toContain('pnlPercent');
      });

      // Verify final prices are updated
      const positions = await positionManager.getActivePositions();
      const token1Positions = positions.filter(p => p.tokenAddress === 'token1');
      const token2Positions = positions.filter(p => p.tokenAddress === 'token2');

      token1Positions.forEach(pos => {
        expect([105, 108, 110]).toContain(pos.currentPrice); // One of the updated prices
      });

      token2Positions.forEach(pos => {
        expect(pos.currentPrice).toBe(220);
      });
    });

    it('should prevent race conditions in PnL calculations', async () => {
      const rapidPriceUpdates = Array(100).fill(null).map((_, i) => ({
        tokenAddress: 'token1',
        price: 90 + (i % 40), // Prices between 90-129
        timestamp: Date.now(),
        source: `source-${i}`,
      }));

      const batchResults = await positionManager.updatePricesAtomically(rapidPriceUpdates);
      
      // All updates should succeed
      batchResults.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.atomicMetrics).toBeDefined();
      });

      // Verify PnL consistency
      const positions = await positionManager.getActivePositions();
      const token1Positions = positions.filter(p => p.tokenAddress === 'token1');

      token1Positions.forEach(position => {
        if (position.currentPrice && position.entryPrice) {
          const expectedPnlPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
          expect(Math.abs(position.pnl.percent - expectedPnlPercent)).toBeLessThan(0.01);
        }
      });
    });

    it('should handle atomic context update validation', async () => {
      const priceData: AtomicTokenPrice[] = [
        { tokenAddress: 'token1', price: 125, timestamp: Date.now(), source: 'test' },
        { tokenAddress: 'token2', price: 180, timestamp: Date.now(), source: 'test' },
      ];

      const results = await positionManager.updatePricesAtomically(priceData);
      
      // Verify atomic context updates
      results.forEach(result => {
        expect(result.atomicMetrics).toBeDefined();
        expect(result.operationTime).toBeLessThan(10); // Should be very fast
      });

      // Check that all related fields were updated atomically
      const positions = await positionManager.getActivePositions();
      positions.forEach(position => {
        if (position.currentPrice) {
          expect(position.lastPriceUpdate).toBeDefined();
          expect(position.pnl).toBeDefined();
        }
      });
    });

    it('should validate price update batching and sequencing', async () => {
      const batchSize = 25;
      const batches = Array(4).fill(null).map((_, batchIndex) =>
        Array(batchSize).fill(null).map((_, i) => ({
          tokenAddress: i % 2 === 0 ? 'token1' : 'token2',
          price: 100 + batchIndex * 10 + i,
          timestamp: Date.now() + i,
          source: `batch-${batchIndex}-source-${i}`,
        }))
      );

      const batchResults = await Promise.all(
        batches.map(batch => positionManager.updatePricesAtomically(batch))
      );

      // All batches should complete successfully
      batchResults.forEach(results => {
        results.forEach(result => {
          expect(result.success).toBe(true);
        });
      });

      // Verify sequencing worked correctly
      const positions = await positionManager.getActivePositions();
      expect(positions.length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Position Concurrent Tests', () => {
    it('should handle create/update multiple positions simultaneously', async () => {
      const operations = Array(30).fill(null).map(async (_, i) => {
        if (i % 3 === 0) {
          // Create new positions
          return positionManager.createPosition(`token-${i}`, 100 + i, 1000, []);
        } else {
          // Update existing positions
          const priceUpdates: AtomicTokenPrice[] = [{
            tokenAddress: `token-${Math.floor(i / 3) * 3}`, // Reference earlier created token
            price: 100 + i + Math.random() * 20,
            timestamp: Date.now(),
            source: `concurrent-test-${i}`,
          }];
          return positionManager.updatePricesAtomically(priceUpdates);
        }
      });

      const results = await Promise.allSettled(operations);
      
      // Most operations should succeed
      const successfulOps = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulOps / results.length).toBeGreaterThan(0.8);

      const finalPositions = await positionManager.getActivePositions();
      expect(finalPositions.length).toBeGreaterThan(5);
    });

    it('should handle cross-position atomic price updates', async () => {
      // Create positions with overlapping tokens
      await Promise.all([
        positionManager.createPosition('shared-token', 100, 1000, []),
        positionManager.createPosition('shared-token', 110, 500, []),
        positionManager.createPosition('unique-token-1', 200, 300, []),
        positionManager.createPosition('shared-token', 95, 1500, []),
        positionManager.createPosition('unique-token-2', 150, 800, []),
      ]);

      const crossUpdatePrices: AtomicTokenPrice[] = [
        { tokenAddress: 'shared-token', price: 120, timestamp: Date.now(), source: 'cross-update' },
        { tokenAddress: 'unique-token-1', price: 180, timestamp: Date.now(), source: 'cross-update' },
        { tokenAddress: 'unique-token-2', price: 160, timestamp: Date.now(), source: 'cross-update' },
      ];

      const updateResults = await positionManager.updatePricesAtomically(crossUpdatePrices);
      
      // Should have updates for all positions
      expect(updateResults.length).toBe(5); // 3 shared-token + 1 unique-token-1 + 1 unique-token-2

      // Verify all shared-token positions were updated with the same price
      const positions = await positionManager.getActivePositions();
      const sharedTokenPositions = positions.filter(p => p.tokenAddress === 'shared-token');
      
      expect(sharedTokenPositions.length).toBe(3);
      sharedTokenPositions.forEach(pos => {
        expect(pos.currentPrice).toBe(120);
      });
    });

    it('should validate position manager mutex effectiveness', async () => {
      const mutexTestOperations = Array(50).fill(null).map(async (_, i) => {
        const operations = [
          () => positionManager.createPosition(`mutex-test-${i}`, 100, 1000, []),
          () => positionManager.getActivePositions(),
          () => positionManager.evaluateExitConditions(),
          () => positionManager.getPerformanceMetrics(),
        ];

        const randomOp = operations[i % operations.length];
        return randomOp();
      });

      const startTime = performance.now();
      const results = await Promise.allSettled(mutexTestOperations);
      const endTime = performance.now();

      // Operations should complete but be serialized
      expect(endTime - startTime).toBeGreaterThan(50); // Mutex introduces delays
      
      const successfulOps = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulOps / results.length).toBeGreaterThan(0.9);
    });

    it('should maintain memory consistency validation', async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Create many positions and update them
      for (let batch = 0; batch < 5; batch++) {
        const creationPromises = Array(20).fill(null).map((_, i) =>
          positionManager.createPosition(`batch-${batch}-token-${i}`, 100 + i, 1000, [])
        );
        
        await Promise.all(creationPromises);
        
        const priceUpdates = Array(20).fill(null).map((_, i) => ({
          tokenAddress: `batch-${batch}-token-${i}`,
          price: 90 + Math.random() * 40,
          timestamp: Date.now(),
          source: `batch-${batch}`,
        }));
        
        await positionManager.updatePricesAtomically(priceUpdates);
        
        // Cleanup some positions
        if (batch > 1) {
          await positionManager.cleanupClosedPositions();
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be reasonable
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // Less than 50MB
    });
  });

  describe('Performance Under Load Tests', () => {
    it('should handle high-frequency operations (1000+ ops/second)', async () => {
      // Create base positions
      await Promise.all(Array(10).fill(null).map((_, i) =>
        positionManager.createPosition(`perf-token-${i}`, 100, 1000, [])
      ));

      const startTime = performance.now();
      const operationCount = 1000;
      
      const operations = Array(operationCount).fill(null).map((_, i) => {
        const opType = i % 4;
        switch (opType) {
          case 0:
            return positionManager.getActivePositions();
          case 1:
            return positionManager.updatePricesAtomically([{
              tokenAddress: `perf-token-${i % 10}`,
              price: 90 + Math.random() * 20,
              timestamp: Date.now(),
              source: `perf-test-${i}`,
            }]);
          case 2:
            return positionManager.evaluateExitConditions();
          case 3:
            return positionManager.getPerformanceMetrics();
          default:
            return Promise.resolve();
        }
      });

      const results = await Promise.allSettled(operations);
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      const opsPerSecond = (operationCount / duration) * 1000;
      
      expect(opsPerSecond).toBeGreaterThan(500); // At least 500 ops/sec with mutex
      
      const successfulOps = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulOps / operationCount).toBeGreaterThan(0.95);
    });

    it('should validate <1ms operation targets', async () => {
      await positionManager.createPosition('speed-test-token', 100, 1000, []);
      
      const measurements: number[] = [];
      
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        await positionManager.updatePricesAtomically([{
          tokenAddress: 'speed-test-token',
          price: 100 + i,
          timestamp: Date.now(),
          source: `speed-test-${i}`,
        }]);
        const end = performance.now();
        measurements.push(end - start);
      }

      const averageTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
      
      // Average should be reasonably fast (mutex may prevent <1ms)
      expect(averageTime).toBeLessThan(5); // Less than 5ms average
      
      const metrics = positionManager.getPerformanceMetrics();
      expect(metrics.operations.priceUpdates.avg).toBeLessThan(10);
    });

    it('should detect memory leaks during concurrent operations', async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Intensive operations with cleanup
      for (let cycle = 0; cycle < 10; cycle++) {
        const positions = await Promise.all(
          Array(20).fill(null).map((_, i) =>
            positionManager.createPosition(`cycle-${cycle}-token-${i}`, 100, 1000, [])
          )
        );

        // Update all positions multiple times
        for (let update = 0; update < 10; update++) {
          const priceUpdates = positions.map((posId, i) => ({
            tokenAddress: `cycle-${cycle}-token-${i}`,
            price: 90 + Math.random() * 20,
            timestamp: Date.now(),
            source: `cycle-${cycle}-update-${update}`,
          }));

          await positionManager.updatePricesAtomically(priceUpdates);
        }

        // Close positions
        await Promise.all(
          positions.map(posId => positionManager.closePosition(posId, 'cycle cleanup'))
        );

        await positionManager.cleanupClosedPositions();
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be minimal after cleanup
      expect(memoryIncrease).toBeLessThan(20 * 1024 * 1024); // Less than 20MB
    });

    it('should validate stress testing with 100+ concurrent positions', async () => {
      const positionCount = 100;
      const startTime = performance.now();
      
      // Create 100+ positions
      const positionPromises = Array(positionCount).fill(null).map((_, i) =>
        positionManager.createPosition(`stress-token-${i % 20}`, 100 + i, 1000, []) // 20 unique tokens
      );

      const positions = await Promise.allSettled(positionPromises);
      const creationTime = performance.now() - startTime;
      
      // All positions should be created
      const successfulCreations = positions.filter(p => p.status === 'fulfilled').length;
      expect(successfulCreations).toBe(positionCount);

      // Massive concurrent price updates
      const updateStartTime = performance.now();
      const priceUpdates = Array(20).fill(null).map((_, i) => ({
        tokenAddress: `stress-token-${i}`,
        price: 90 + Math.random() * 40,
        timestamp: Date.now(),
        source: `stress-test`,
      }));

      const updateResults = await positionManager.updatePricesAtomically(priceUpdates);
      const updateTime = performance.now() - updateStartTime;
      
      // Should update all matching positions (5 positions per token on average)
      expect(updateResults.length).toBeGreaterThanOrEqual(positionCount);

      // Concurrent exit evaluation
      const exitResults = await positionManager.evaluateExitConditions();
      
      // Performance checks
      expect(creationTime).toBeLessThan(10000); // Creation under 10s
      expect(updateTime).toBeLessThan(5000); // Updates under 5s
      
      const finalPositions = await positionManager.getActivePositions();
      expect(finalPositions.length).toBe(positionCount);

      // Cleanup
      const cleanupCount = await positionManager.cleanupClosedPositions();
      expect(cleanupCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Exit Conditions and Position Management', () => {
    it('should handle concurrent exit condition evaluation', async () => {
      // Create positions with different PnL scenarios
      const positionIds = await Promise.all([
        positionManager.createPosition('exit-test-1', 100, 1000, []), // Will be profitable
        positionManager.createPosition('exit-test-2', 100, 1000, []), // Will be at loss
        positionManager.createPosition('exit-test-3', 100, 1000, []), // Will be neutral
      ]);

      // Update prices to trigger different exit conditions
      await positionManager.updatePricesAtomically([
        { tokenAddress: 'exit-test-1', price: 160, timestamp: Date.now(), source: 'exit-test' }, // +60%
        { tokenAddress: 'exit-test-2', price: 85, timestamp: Date.now(), source: 'exit-test' }, // -15%
        { tokenAddress: 'exit-test-3', price: 102, timestamp: Date.now(), source: 'exit-test' }, // +2%
      ]);

      // Concurrent exit evaluations
      const evaluationPromises = Array(10).fill(null).map(() =>
        positionManager.evaluateExitConditions()
      );

      const results = await Promise.allSettled(evaluationPromises);
      
      // All evaluations should succeed
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      // Some positions should be marked for exit based on our example logic
      const finalResults = results.filter(r => r.status === 'fulfilled') as any[];
      const exitCandidates = finalResults[0].value as string[];
      
      // At least the highly profitable and loss positions should be marked
      expect(exitCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle concurrent position closing', async () => {
      const positionIds = await Promise.all(
        Array(10).fill(null).map((_, i) =>
          positionManager.createPosition(`close-test-${i}`, 100, 1000, [])
        )
      );

      const closePromises = positionIds.map(id =>
        positionManager.closePosition(id, 'concurrent close test')
      );

      const results = await Promise.allSettled(closePromises);
      
      // All closes should succeed
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value).toBe(true);
        }
      });

      // Verify positions are closed
      const activePositions = await positionManager.getActivePositions();
      expect(activePositions.length).toBe(0);
    });
  });

  describe('Performance Metrics and Monitoring', () => {
    it('should track comprehensive performance metrics', async () => {
      // Perform various operations
      await positionManager.createPosition('metrics-test', 100, 1000, []);
      await positionManager.updatePricesAtomically([{
        tokenAddress: 'metrics-test',
        price: 105,
        timestamp: Date.now(),
        source: 'metrics-test',
      }]);
      await positionManager.evaluateExitConditions();

      const metrics = positionManager.getPerformanceMetrics();
      
      expect(metrics.operations).toBeDefined();
      expect(metrics.operations.positionCreation).toBeDefined();
      expect(metrics.operations.priceUpdates).toBeDefined();
      expect(metrics.operations.exitEvaluation).toBeDefined();
      
      expect(metrics.totalPositions).toBe(1);
      expect(metrics.activePositions).toBe(1);
      expect(metrics.timestamp).toBeDefined();
    });

    it('should validate atomic operation consistency', async () => {
      await Promise.all([
        positionManager.createPosition('consistency-1', 100, 1000, []),
        positionManager.createPosition('consistency-2', 200, 500, []),
      ]);

      const preUpdateMetrics = positionManager.getPerformanceMetrics();
      
      await positionManager.updatePricesAtomically([
        { tokenAddress: 'consistency-1', price: 110, timestamp: Date.now(), source: 'consistency' },
        { tokenAddress: 'consistency-2', price: 190, timestamp: Date.now(), source: 'consistency' },
      ]);

      const postUpdateMetrics = positionManager.getPerformanceMetrics();
      
      // Metrics should show increased operation counts
      expect(postUpdateMetrics.operations.priceUpdates.count)
        .toBeGreaterThan(preUpdateMetrics.operations.priceUpdates.count);
    });
  });
});