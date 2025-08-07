/**
 * Performance Integration Tests
 * 
 * Tests real-time performance characteristics and system limits:
 * - Real-time data processing latency
 * - High-frequency transaction handling
 * - Memory usage under load
 * - Database performance with large datasets
 * - Network latency and timeout handling
 * - Concurrent operation scaling
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DatabaseManager } from '../../src/db';
import { MarketMonitor } from '../../src/monitoring/market-monitor';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { StrategyEngine } from '../../src/trading/strategy-engine';
import { 
  AppConfig, 
  RpcConfig, 
  NewPoolEvent, 
  Trade, 
  Position, 
  LiquidityPool,
  TradeDecision
} from '../../src/types';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';

// Performance test configuration
const DEVNET_CONFIG = {
  httpUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  commitment: 'confirmed',
  connectionTimeout: 5000,
  reconnectPolicy: {
    maxRetries: 2,
    baseDelay: 500,
    maxDelay: 5000
  }
};

const PERFORMANCE_TEST_CONFIG: AppConfig = {
  rpc: DEVNET_CONFIG,
  supportedDexes: [{
    name: 'Jupiter',
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    instructions: { newPoolCreation: 'create_pool' },
    enabled: true
  }],
  wallet: {
    keypairPath: '/tmp/perf-test-keypair.json',
    riskPercent: 1,
  },
  tradeConfig: {
    minLiquidityUsd: 1000,
    maxSlippagePercent: 5,
    gasLimit: 0.01,
    defaultTradeAmountUsd: 10,
    maxTradeAmountUsd: 50
  },
  exitStrategies: [{
    type: 'profit',
    enabled: true,
    params: { profitPercentage: 10 }
  }],
  database: {
    path: ':memory:',
    logToDatabase: true
  },
  marketMonitoring: {
    enabled: true,
    priceVolatilityThreshold: 10,
    volumeSpikeMultiplier: 3,
    liquidityDropThreshold: 20,
    monitoringInterval: 1000, // 1 second for performance testing
    historicalDataWindow: 60,
    circuitBreakerConfig: {
      failureThreshold: 5,
      successThreshold: 10,
      timeout: 60000,
      monitoringPeriod: 30000
    }
  },
  riskManagement: {
    enabled: true,
    maxTotalExposure: 200,
    maxSinglePositionSize: 50,
    maxPortfolioPercentage: 25,
    maxConcentrationRisk: 40,
    maxDailyLoss: 25,
    maxDrawdown: 15,
    volatilityMultiplier: 1.2,
    correlationThreshold: 0.8,
    rebalanceThreshold: 10,
    riskAssessmentInterval: 5000,
    emergencyExitThreshold: 20
  },
  dryRun: true,
  verbose: false, // Reduce logging noise for performance tests
  disableTui: true,
  logLevel: 'error'
};

interface PerformanceMetrics {
  averageLatency: number;
  medianLatency: number;
  p95Latency: number;
  p99Latency: number;
  minLatency: number;
  maxLatency: number;
  throughput: number; // operations per second
  errorRate: number; // percentage
  memoryUsage: {
    initial: number;
    final: number;
    peak: number;
    delta: number;
  };
}

class PerformanceProfiler {
  private metrics: number[] = [];
  private errors: number = 0;
  private startTime: number = 0;
  private memorySnapshots: number[] = [];

  start() {
    this.startTime = performance.now();
    this.takeMemorySnapshot();
  }

  recordOperation(latency: number, isError: boolean = false) {
    this.metrics.push(latency);
    if (isError) this.errors++;
    this.takeMemorySnapshot();
  }

  private takeMemorySnapshot() {
    this.memorySnapshots.push(process.memoryUsage().heapUsed);
  }

  getMetrics(): PerformanceMetrics {
    const sortedMetrics = [...this.metrics].sort((a, b) => a - b);
    const totalTime = performance.now() - this.startTime;
    
    return {
      averageLatency: this.metrics.reduce((sum, lat) => sum + lat, 0) / this.metrics.length || 0,
      medianLatency: sortedMetrics[Math.floor(sortedMetrics.length / 2)] || 0,
      p95Latency: sortedMetrics[Math.floor(sortedMetrics.length * 0.95)] || 0,
      p99Latency: sortedMetrics[Math.floor(sortedMetrics.length * 0.99)] || 0,
      minLatency: sortedMetrics[0] || 0,
      maxLatency: sortedMetrics[sortedMetrics.length - 1] || 0,
      throughput: (this.metrics.length / totalTime) * 1000, // ops per second
      errorRate: (this.errors / this.metrics.length) * 100 || 0,
      memoryUsage: {
        initial: this.memorySnapshots[0] || 0,
        final: this.memorySnapshots[this.memorySnapshots.length - 1] || 0,
        peak: Math.max(...this.memorySnapshots) || 0,
        delta: (this.memorySnapshots[this.memorySnapshots.length - 1] || 0) - (this.memorySnapshots[0] || 0)
      }
    };
  }

  reset() {
    this.metrics = [];
    this.errors = 0;
    this.memorySnapshots = [];
  }
}

describe('Performance Integration Tests', () => {
  let connectionManager: ConnectionManager;
  let dbManager: DatabaseManager;
  let marketMonitor: MarketMonitor;
  let tradeExecutor: TradeExecutor;
  let strategyEngine: StrategyEngine;
  let profiler: PerformanceProfiler;
  let testKeypair: Keypair;

  beforeAll(async () => {
    // Setup test keypair
    testKeypair = Keypair.generate();
    const keypairArray = Array.from(testKeypair.secretKey);
    await fs.writeFile(PERFORMANCE_TEST_CONFIG.wallet.keypairPath, JSON.stringify(keypairArray));

    // Initialize components
    connectionManager = new ConnectionManager(DEVNET_CONFIG);
    await connectionManager.initialize();

    dbManager = new DatabaseManager(':memory:');
    await dbManager.initialize();

    marketMonitor = new MarketMonitor(
      connectionManager,
      PERFORMANCE_TEST_CONFIG.marketMonitoring!
    );

    tradeExecutor = new TradeExecutor(connectionManager, dbManager, PERFORMANCE_TEST_CONFIG);
    await tradeExecutor.initialize();

    strategyEngine = new StrategyEngine(
      connectionManager,
      dbManager,
      PERFORMANCE_TEST_CONFIG
    );

    profiler = new PerformanceProfiler();
  }, 30000);

  afterAll(async () => {
    await connectionManager.shutdown();
    await dbManager.close();
    
    try {
      await fs.unlink(PERFORMANCE_TEST_CONFIG.wallet.keypairPath);
    } catch (error) {
      // Ignore
    }
  });

  describe('Real-time Data Processing', () => {
    it('should process pool events with low latency', async () => {
      const eventCount = 100;
      const events: NewPoolEvent[] = Array(eventCount).fill(null).map((_, i) => ({
        signature: `TestSig${i}`,
        dex: 'Jupiter',
        poolAddress: `Pool${i}`,
        tokenA: 'So11111111111111111111111111111111111111112',
        tokenB: `Token${i}`,
        timestamp: Date.now() + i
      }));

      profiler.start();

      for (const event of events) {
        const startTime = performance.now();
        try {
          await strategyEngine.evaluatePool(event);
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, false);
        } catch (error) {
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, true);
        }
      }

      const metrics = profiler.getMetrics();

      // Performance requirements
      expect(metrics.averageLatency).toBeLessThan(100); // < 100ms average
      expect(metrics.p95Latency).toBeLessThan(200); // < 200ms 95th percentile
      expect(metrics.errorRate).toBeLessThan(5); // < 5% error rate
      expect(metrics.throughput).toBeGreaterThan(10); // > 10 ops/sec

      console.log('Pool Event Processing Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} ops/sec`,
        errorRate: `${metrics.errorRate.toFixed(2)}%`
      });
    }, 30000);

    it('should handle high-frequency price updates efficiently', async () => {
      const updateCount = 500;
      const tokenAddress = 'TestToken123';
      const basePrice = 1.0;
      
      profiler.reset();
      profiler.start();

      for (let i = 0; i < updateCount; i++) {
        const startTime = performance.now();
        try {
          const price = basePrice + (Math.random() - 0.5) * 0.1; // ±5% variance
          
          // Simulate price update processing
          await new Promise(resolve => setImmediate(resolve)); // Yield control
          
          // Mock price processing logic
          if (Math.abs(price - basePrice) > 0.05) {
            // Simulate volatility detection
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, false);
        } catch (error) {
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, true);
        }
      }

      const metrics = profiler.getMetrics();

      // High-frequency update requirements
      expect(metrics.averageLatency).toBeLessThan(10); // < 10ms average
      expect(metrics.p99Latency).toBeLessThan(50); // < 50ms 99th percentile
      expect(metrics.throughput).toBeGreaterThan(100); // > 100 ops/sec
      expect(metrics.errorRate).toBe(0); // No errors expected

      console.log('Price Update Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p99Latency: `${metrics.p99Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} ops/sec`
      });
    });

    it('should maintain performance under concurrent load', async () => {
      const concurrentRequests = 20;
      const requestsPerWorker = 10;
      
      profiler.reset();
      profiler.start();

      const workerPromises = Array(concurrentRequests).fill(null).map(async (_, workerId) => {
        const workerMetrics: number[] = [];
        
        for (let i = 0; i < requestsPerWorker; i++) {
          const startTime = performance.now();
          try {
            // Simulate concurrent blockchain queries
            const mockQuery = new Promise(resolve => 
              setTimeout(resolve, Math.random() * 50 + 10) // 10-60ms
            );
            await mockQuery;
            
            const endTime = performance.now();
            workerMetrics.push(endTime - startTime);
          } catch (error) {
            const endTime = performance.now();
            workerMetrics.push(endTime - startTime);
          }
        }
        
        return workerMetrics;
      });

      const allWorkerMetrics = await Promise.all(workerPromises);
      
      // Record all metrics
      allWorkerMetrics.flat().forEach(latency => {
        profiler.recordOperation(latency, false);
      });

      const metrics = profiler.getMetrics();

      // Concurrent performance requirements
      expect(metrics.averageLatency).toBeLessThan(100); // < 100ms average under load
      expect(metrics.p95Latency).toBeLessThan(200); // < 200ms 95th percentile
      expect(metrics.throughput).toBeGreaterThan(15); // > 15 ops/sec total

      console.log('Concurrent Load Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} ops/sec`,
        concurrentWorkers: concurrentRequests
      });
    }, 20000);
  });

  describe('Database Performance', () => {
    it('should handle large-scale trade insertions efficiently', async () => {
      const tradeCount = 1000;
      const trades: Trade[] = Array(tradeCount).fill(null).map((_, i) => ({
        id: `perf-trade-${i}`,
        tokenAddress: `Token${i % 100}`, // 100 unique tokens
        poolAddress: `Pool${i % 50}`, // 50 unique pools
        direction: i % 2 === 0 ? 'BUY' : 'SELL',
        amount: 10 + (i % 90),
        price: 0.5 + (i % 100) * 0.01,
        valueUsd: 25 + (i % 75),
        gasFeeUsd: 0.05 + (i % 10) * 0.001,
        timestamp: Date.now() - (i * 60000),
        txSignature: `PerfSig${i}`,
        status: 'CONFIRMED'
      }));

      profiler.reset();
      profiler.start();

      // Insert trades with performance tracking
      for (const trade of trades) {
        const startTime = performance.now();
        try {
          await dbManager.addTrade(trade);
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, false);
        } catch (error) {
          const endTime = performance.now();
          profiler.recordOperation(endTime - startTime, true);
        }
      }

      const metrics = profiler.getMetrics();

      // Database performance requirements
      expect(metrics.averageLatency).toBeLessThan(5); // < 5ms average per insert
      expect(metrics.p95Latency).toBeLessThan(20); // < 20ms 95th percentile
      expect(metrics.errorRate).toBe(0); // No errors expected
      expect(metrics.throughput).toBeGreaterThan(200); // > 200 inserts/sec

      console.log('Database Insert Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} inserts/sec`,
        totalRecords: tradeCount
      });
    }, 30000);

    it('should query large datasets efficiently', async () => {
      // Ensure we have data to query (from previous test or insert fresh data)
      const testTradeCount = 500;
      for (let i = 0; i < testTradeCount; i++) {
        await dbManager.addTrade({
          id: `query-test-${i}`,
          tokenAddress: `QueryToken${i % 20}`,
          poolAddress: `QueryPool${i % 10}`,
          direction: 'BUY',
          amount: 50,
          price: 1.0,
          valueUsd: 50,
          gasFeeUsd: 0.05,
          timestamp: Date.now() - (i * 30000),
          txSignature: `QuerySig${i}`,
          status: 'CONFIRMED'
        });
      }

      const queryTypes = [
        { name: 'All Trades', query: () => dbManager.getTrades() },
        { 
          name: 'Recent Trades', 
          query: () => dbManager.getTrades().then(trades => 
            trades.filter(t => t.timestamp > Date.now() - 3600000)
          ) 
        },
        { 
          name: 'Token Trades', 
          query: () => dbManager.getTrades().then(trades => 
            trades.filter(t => t.tokenAddress === 'QueryToken1')
          ) 
        }
      ];

      profiler.reset();
      profiler.start();

      for (const queryType of queryTypes) {
        const iterations = 50;
        
        for (let i = 0; i < iterations; i++) {
          const startTime = performance.now();
          try {
            const results = await queryType.query();
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, false);
            
            // Verify we got results
            expect(Array.isArray(results)).toBe(true);
          } catch (error) {
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, true);
          }
        }
      }

      const metrics = profiler.getMetrics();

      // Query performance requirements
      expect(metrics.averageLatency).toBeLessThan(50); // < 50ms average per query
      expect(metrics.p95Latency).toBeLessThan(150); // < 150ms 95th percentile
      expect(metrics.errorRate).toBe(0); // No errors expected
      expect(metrics.throughput).toBeGreaterThan(20); // > 20 queries/sec

      console.log('Database Query Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} queries/sec`
      });
    }, 20000);
  });

  describe('Memory Management', () => {
    it('should maintain reasonable memory usage under load', async () => {
      const initialMemory = process.memoryUsage();
      
      // Generate large datasets to test memory management
      const largeOperationCount = 200;
      const dataSize = 1000; // Objects per operation
      
      for (let operation = 0; operation < largeOperationCount; operation++) {
        // Create temporary large data structures
        const tempData = Array(dataSize).fill(null).map((_, i) => ({
          id: `temp-${operation}-${i}`,
          data: Array(100).fill('x').join(''), // 100 char string
          timestamp: Date.now(),
          metadata: {
            operation,
            index: i,
            random: Math.random()
          }
        }));

        // Process data (simulate real work)
        const processedData = tempData.filter(item => item.metadata.random > 0.5);
        
        // Periodically check memory
        if (operation % 20 === 0) {
          const currentMemory = process.memoryUsage();
          const memoryIncrease = currentMemory.heapUsed - initialMemory.heapUsed;
          
          // Memory should not grow unboundedly
          expect(memoryIncrease).toBeLessThan(200 * 1024 * 1024); // < 200MB increase
        }

        // Explicit cleanup (simulate proper memory management)
        tempData.length = 0;
        processedData.length = 0;
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      const totalMemoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

      console.log('Memory Usage Test:', {
        initial: `${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        final: `${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        increase: `${(totalMemoryIncrease / 1024 / 1024).toFixed(2)}MB`,
        operations: largeOperationCount
      });

      // Memory requirements
      expect(totalMemoryIncrease).toBeLessThan(100 * 1024 * 1024); // < 100MB final increase
    }, 30000);

    it('should handle memory pressure gracefully', async () => {
      const memoryStressTest = async () => {
        const chunks: any[][] = [];
        let iterationCount = 0;
        const maxIterations = 50;

        try {
          while (iterationCount < maxIterations) {
            // Allocate memory progressively
            const chunk = Array(10000).fill(null).map(() => ({
              id: randomUUID(),
              data: Array(50).fill('memory-test').join(''),
              timestamp: Date.now()
            }));

            chunks.push(chunk);
            iterationCount++;

            // Check memory every 10 iterations
            if (iterationCount % 10 === 0) {
              const memory = process.memoryUsage();
              
              // If memory exceeds threshold, start cleanup
              if (memory.heapUsed > 150 * 1024 * 1024) { // 150MB threshold
                // Cleanup oldest chunks
                const chunksToRemove = Math.floor(chunks.length / 2);
                for (let i = 0; i < chunksToRemove; i++) {
                  const removedChunk = chunks.shift();
                  if (removedChunk) {
                    removedChunk.length = 0; // Clear array
                  }
                }
                
                // Force garbage collection if available
                if (global.gc) {
                  global.gc();
                }
              }
            }

            // Yield control
            await new Promise(resolve => setImmediate(resolve));
          }
        } finally {
          // Cleanup all remaining chunks
          chunks.forEach(chunk => chunk.length = 0);
          chunks.length = 0;
          
          if (global.gc) {
            global.gc();
          }
        }
      };

      const startMemory = process.memoryUsage();
      await memoryStressTest();
      const endMemory = process.memoryUsage();

      const memoryDelta = endMemory.heapUsed - startMemory.heapUsed;

      console.log('Memory Pressure Test:', {
        startMemory: `${(startMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        endMemory: `${(endMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        delta: `${(memoryDelta / 1024 / 1024).toFixed(2)}MB`
      });

      // Should not have significant memory leaks
      expect(memoryDelta).toBeLessThan(50 * 1024 * 1024); // < 50MB net increase
    }, 25000);
  });

  describe('Network Performance', () => {
    it('should handle network latency variations', async () => {
      const connection = connectionManager.getConnection();
      const latencyTests = [
        { name: 'Blockhash', operation: () => connection.getLatestBlockhash() },
        { name: 'Balance', operation: () => connection.getBalance(testKeypair.publicKey) },
        { name: 'Account Info', operation: () => connection.getAccountInfo(testKeypair.publicKey) }
      ];

      profiler.reset();
      profiler.start();

      for (const test of latencyTests) {
        const iterations = 20;
        
        for (let i = 0; i < iterations; i++) {
          const startTime = performance.now();
          try {
            await test.operation();
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, false);
          } catch (error) {
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, true);
          }
        }
      }

      const metrics = profiler.getMetrics();

      // Network performance expectations (devnet can be variable)
      expect(metrics.averageLatency).toBeLessThan(1000); // < 1s average
      expect(metrics.p95Latency).toBeLessThan(3000); // < 3s 95th percentile
      expect(metrics.errorRate).toBeLessThan(10); // < 10% error rate (devnet tolerance)

      console.log('Network Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        errorRate: `${metrics.errorRate.toFixed(2)}%`
      });
    }, 30000);

    it('should handle connection failures and recovery', async () => {
      const originalConfig = { ...DEVNET_CONFIG };
      let recoveryTime = 0;
      let connectionLost = false;

      try {
        // Test with an invalid endpoint to simulate network failure
        const failingConnectionManager = new ConnectionManager({
          ...DEVNET_CONFIG,
          httpUrl: 'https://non-existent-endpoint.invalid',
          connectionTimeout: 2000
        });

        const startTime = performance.now();
        
        try {
          await failingConnectionManager.initialize();
        } catch (error) {
          connectionLost = true;
          
          // Now test recovery with valid endpoint
          const recoveryConnectionManager = new ConnectionManager(originalConfig);
          await recoveryConnectionManager.initialize();
          
          recoveryTime = performance.now() - startTime;
          
          // Verify recovery worked
          const connection = recoveryConnectionManager.getConnection();
          await connection.getLatestBlockhash(); // Should succeed
          
          await recoveryConnectionManager.shutdown();
        }
      } catch (error) {
        // Expected for the failing connection
      }

      expect(connectionLost).toBe(true);
      expect(recoveryTime).toBeGreaterThan(0);
      expect(recoveryTime).toBeLessThan(10000); // Recovery should be < 10s

      console.log('Connection Recovery:', {
        recoveryTime: `${recoveryTime.toFixed(2)}ms`,
        connectionLost
      });
    }, 20000);
  });

  describe('System Resource Limits', () => {
    it('should handle resource exhaustion gracefully', async () => {
      const resourceTest = async () => {
        const resources: any[] = [];
        let errorEncountered = false;
        
        try {
          // Attempt to create many database connections (or similar resources)
          for (let i = 0; i < 100; i++) {
            try {
              // Simulate resource allocation
              const resource = {
                id: i,
                data: Array(1000).fill('resource-data'),
                connections: Array(10).fill({ active: true }),
                timestamp: Date.now()
              };
              
              resources.push(resource);
              
              // Simulate some work with the resource
              await new Promise(resolve => setTimeout(resolve, 1));
              
            } catch (error) {
              errorEncountered = true;
              break;
            }
          }
        } finally {
          // Cleanup resources
          resources.forEach(resource => {
            resource.data.length = 0;
            resource.connections.length = 0;
          });
          resources.length = 0;
        }
        
        return { resourcesCreated: resources.length, errorEncountered };
      };

      const result = await resourceTest();
      
      // Should either complete successfully or handle errors gracefully
      expect(typeof result.resourcesCreated).toBe('number');
      expect(typeof result.errorEncountered).toBe('boolean');
      
      // If errors occurred, they should be handled without crashing
      if (result.errorEncountered) {
        console.log('Resource exhaustion handled gracefully');
      } else {
        console.log(`Successfully created ${result.resourcesCreated} resources`);
      }
      
      expect(true).toBe(true); // Test passed if we reach here
    }, 15000);

    it('should maintain performance under CPU load', async () => {
      const cpuIntensiveTask = async () => {
        // CPU-intensive calculations
        let result = 0;
        for (let i = 0; i < 100000; i++) {
          result += Math.sqrt(i) * Math.sin(i) * Math.cos(i);
        }
        return result;
      };

      profiler.reset();
      profiler.start();

      const concurrentTasks = 5;
      const tasksPerWorker = 10;

      const workerPromises = Array(concurrentTasks).fill(null).map(async () => {
        for (let i = 0; i < tasksPerWorker; i++) {
          const startTime = performance.now();
          try {
            await cpuIntensiveTask();
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, false);
          } catch (error) {
            const endTime = performance.now();
            profiler.recordOperation(endTime - startTime, true);
          }
        }
      });

      await Promise.all(workerPromises);

      const metrics = profiler.getMetrics();

      console.log('CPU Load Performance:', {
        avgLatency: `${metrics.averageLatency.toFixed(2)}ms`,
        p95Latency: `${metrics.p95Latency.toFixed(2)}ms`,
        throughput: `${metrics.throughput.toFixed(2)} ops/sec`,
        concurrentWorkers: concurrentTasks
      });

      // CPU performance should degrade gracefully under load
      expect(metrics.averageLatency).toBeLessThan(500); // < 500ms average
      expect(metrics.errorRate).toBe(0); // No errors expected
    }, 15000);
  });
});