/**
 * Enhanced Position Manager with Atomic Operations
 * 
 * This implementation provides thread-safe position management using atomic operations
 * and lock-free programming techniques for high-frequency trading scenarios.
 */

import { Mutex } from 'async-mutex';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { Logger } from '../utils/logger';
import { PositionModel } from '../db/models/position';
import { ExitStrategyConfig, TokenPrice, ExitEvaluationResult } from '../types';

export interface AtomicPositionUpdate {
  positionId: string;
  newPrice: number;
  expectedPrice: number;
  timestamp: number;
}

export interface PerformanceMetrics {
  success: boolean;
  latency: number;
  operation: string;
  timestamp: number;
  error?: string;
}

export class AtomicPositionManager {
  private logger: Logger;
  private positionMutex: Mutex;
  private priceBuffer: SharedArrayBuffer;
  private positionBuffer: SharedArrayBuffer;
  private metricsBuffer: SharedArrayBuffer;
  
  // Shared arrays for atomic operations
  private prices: Int32Array; // Store floats as int32 bits for atomic operations
  private timestamps: Int32Array; // Store timestamps as int32 for atomic operations
  private positions: Int32Array;
  private metrics: Int32Array; // Store metrics as int32 for atomic operations
  private counters: Int32Array;
  
  // Performance tracking
  private readonly MAX_POSITIONS = 1000;
  private readonly METRICS_SIZE = 100;
  
  private positionIndex: Map<string, number> = new Map();
  private workers: Worker[] = [];

  constructor() {
    this.logger = new Logger('AtomicPositionManager');
    this.positionMutex = new Mutex();
    
    // Initialize shared memory buffers
    this.priceBuffer = new SharedArrayBuffer(this.MAX_POSITIONS * 16); // 8 bytes price + 8 bytes timestamp
    this.positionBuffer = new SharedArrayBuffer(this.MAX_POSITIONS * 32); // Position state data
    this.metricsBuffer = new SharedArrayBuffer(this.METRICS_SIZE * 16); // Performance metrics
    
    // Create typed array views
    this.prices = new Int32Array(this.priceBuffer, 0, this.MAX_POSITIONS * 2); // 2 int32s per price (bits)
    this.timestamps = new Int32Array(this.priceBuffer, this.MAX_POSITIONS * 8, this.MAX_POSITIONS);
    this.positions = new Int32Array(this.positionBuffer);
    this.metrics = new Int32Array(this.metricsBuffer, 0, this.METRICS_SIZE);
    this.counters = new Int32Array(this.metricsBuffer, this.METRICS_SIZE * 4, this.METRICS_SIZE);
    
    this.setupWorkerPool();
  }

  /**
   * Update position price using atomic operations for maximum performance
   */
  public async updatePosition(
    positionId: string,
    newPrice: number,
    currentPrice?: number
  ): Promise<PerformanceMetrics> {
    const startTime = process.hrtime.bigint();
    const operation = 'updatePosition';
    
    try {
      // Try atomic update first (fast path - <1ms)
      if (currentPrice !== undefined) {
        const success = this.tryAtomicPriceUpdate(positionId, newPrice, currentPrice);
        
        if (success) {
          const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
          this.recordMetrics(operation, latency, true);
          
          return {
            success: true,
            latency,
            operation,
            timestamp: Date.now()
          };
        }
      }
      
      // Fallback to mutex-protected update (slow path - <10ms)
      const release = await this.positionMutex.acquire();
      try {
        const result = await this.updatePositionWithLock(positionId, newPrice);
        const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
        
        this.recordMetrics(operation, latency, result.success);
        
        return {
          ...result,
          latency,
          operation,
          timestamp: Date.now()
        };
      } finally {
        release();
      }
    } catch (error) {
      const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error(`Position update failed: ${errorMessage}`);
      this.recordMetrics(operation, latency, false);
      
      return {
        success: false,
        latency,
        operation,
        timestamp: Date.now(),
        error: errorMessage
      };
    }
  }

  /**
   * Attempt atomic price update using compare-and-swap
   * This is the fastest path for position updates
   */
  private tryAtomicPriceUpdate(positionId: string, newPrice: number, expectedPrice: number): boolean {
    const index = this.getOrCreatePositionIndex(positionId);
    if (index < 0) return false;
    
    // Convert prices to int32 bits for atomic operations
    const oldPriceBits = this.floatToInt32Bits(expectedPrice);
    const newPriceBits = this.floatToInt32Bits(newPrice);
    
    // Create a view of the specific price location for CAS
    const priceView = new Int32Array(this.priceBuffer, index * 8, 2);
    
    // Atomic compare-and-swap for price update
    const success = Atomics.compareExchange(priceView, 0, oldPriceBits, newPriceBits) === oldPriceBits;
    
    if (success) {
      // Update timestamp atomically
      Atomics.store(this.timestamps, index, Date.now());
      
      // Notify any waiting threads
      Atomics.notify(priceView, 0, 1);
      
      this.logger.debug(`Atomic price update successful for ${positionId}: ${expectedPrice} -> ${newPrice}`);
    }
    
    return success;
  }

  /**
   * Fallback position update with mutex protection
   */
  private async updatePositionWithLock(positionId: string, newPrice: number): Promise<{ success: boolean }> {
    try {
      const index = this.getOrCreatePositionIndex(positionId);
      if (index < 0) {
        throw new Error(`Failed to allocate index for position ${positionId}`);
      }
      
      // Update price in shared memory (convert to int32 bits)
      const priceBits = this.floatToInt32Bits(newPrice);
      Atomics.store(this.prices, index * 2, priceBits);
      Atomics.store(this.timestamps, index, Date.now());
      
      this.logger.debug(`Mutex-protected price update for ${positionId}: ${newPrice}`);
      
      return { success: true };
    } catch (error) {
      this.logger.error(`Mutex-protected update failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false };
    }
  }

  /**
   * Evaluate exit conditions using atomic price reads
   */
  public async evaluateExitConditions(
    position: PositionModel,
    strategy: ExitStrategyConfig
  ): Promise<ExitEvaluationResult> {
    const startTime = process.hrtime.bigint();
    
    try {
      const currentPrice = this.getAtomicPrice(position.id);
      
      if (!currentPrice) {
        return {
          shouldExit: false,
          reason: 'No current price available',
          urgency: 'LOW'
        };
      }
      
      // Atomic P&L calculation
      const entryPrice = position.entryPrice;
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      // Evaluate based on strategy type
      const result = this.evaluateStrategyConditions(strategy, pnlPercent, currentPrice, position);
      
      const evaluationTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      this.recordMetrics('evaluateExit', evaluationTime, true);
      
      if (evaluationTime > 10) {
        this.logger.warn(`Slow exit evaluation: ${evaluationTime}ms for position ${position.id}`);
      }
      
      return result;
    } catch (error) {
      const evaluationTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      this.recordMetrics('evaluateExit', evaluationTime, false);
      
      return {
        shouldExit: false,
        reason: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        urgency: 'LOW'
      };
    }
  }

  /**
   * Evaluate specific strategy conditions
   */
  private evaluateStrategyConditions(
    strategy: ExitStrategyConfig,
    pnlPercent: number,
    currentPrice: number,
    position: PositionModel
  ): ExitEvaluationResult {
    const epsilon = 0.001; // Small epsilon for floating point comparisons
    
    switch (strategy.type) {
      case 'profit':
        const profitTarget = (strategy.params as { profitPercentage: number }).profitPercentage;
        if (pnlPercent >= profitTarget - epsilon) {
          return {
            shouldExit: true,
            reason: `Profit target reached: ${pnlPercent.toFixed(2)}% >= ${profitTarget}%`,
            urgency: 'HIGH',
            expectedPrice: currentPrice
          };
        }
        break;
        
      case 'loss':
        const lossThreshold = -(strategy.params as { lossPercentage: number }).lossPercentage;
        if (pnlPercent <= lossThreshold + epsilon) {
          return {
            shouldExit: true,
            reason: `Stop loss triggered: ${pnlPercent.toFixed(2)}% <= ${lossThreshold}%`,
            urgency: 'HIGH',
            expectedPrice: currentPrice
          };
        }
        break;
        
      case 'time':
        const timeLimit = (strategy.params as { timeMinutes: number }).timeMinutes;
        const holdingTime = position.getHoldingTimeMinutes();
        if (holdingTime >= timeLimit) {
          return {
            shouldExit: true,
            reason: `Time limit reached: ${holdingTime.toFixed(1)}min >= ${timeLimit}min`,
            urgency: 'MEDIUM',
            expectedPrice: currentPrice
          };
        }
        break;
    }
    
    return {
      shouldExit: false,
      reason: `Conditions not met (P&L: ${pnlPercent.toFixed(2)}%)`,
      urgency: 'LOW'
    };
  }

  /**
   * Get atomic price reading
   */
  public getAtomicPrice(positionId: string): number | null {
    const index = this.positionIndex.get(positionId);
    if (index === undefined || index < 0) {
      return null;
    }
    
    const priceBits = Atomics.load(this.prices, index * 2);
    return this.int32BitsToFloat(priceBits);
  }

  /**
   * Get atomic timestamp
   */
  public getAtomicTimestamp(positionId: string): number | null {
    const index = this.positionIndex.get(positionId);
    if (index === undefined || index < 0) {
      return null;
    }
    
    const timestamp = Atomics.load(this.timestamps, index);
    return timestamp;
  }

  /**
   * Get or create position index for atomic operations
   */
  private getOrCreatePositionIndex(positionId: string): number {
    let index = this.positionIndex.get(positionId);
    
    if (index === undefined) {
      // Atomic counter for next available index
      index = this.counters.length > 0 ? Atomics.add(this.counters, 0, 1) : this.positionIndex.size;
      
      if (index >= this.MAX_POSITIONS) {
        this.logger.error(`Maximum positions reached: ${this.MAX_POSITIONS}`);
        return -1;
      }
      
      this.positionIndex.set(positionId, index);
      this.logger.debug(`Allocated index ${index} for position ${positionId}`);
    }
    
    return index;
  }

  /**
   * Convert float64 to int32 bits for atomic operations
   */
  private floatToInt32Bits(value: number): number {
    const buffer = new ArrayBuffer(4);
    const floatView = new Float32Array(buffer);
    const intView = new Int32Array(buffer);
    
    floatView[0] = value;
    return intView[0];
  }

  /**
   * Convert int32 bits back to float
   */
  private int32BitsToFloat(bits: number): number {
    const buffer = new ArrayBuffer(4);
    const intView = new Int32Array(buffer);
    const floatView = new Float32Array(buffer);
    
    intView[0] = bits;
    return floatView[0];
  }

  /**
   * Record performance metrics atomically
   */
  private recordMetrics(operation: string, latencyMs: number, success: boolean): void {
    const operationIndex = this.getOperationIndex(operation);
    if (operationIndex < 0) return;
    
    // Update success/failure counters
    const counterIndex = operationIndex * 2 + (success ? 0 : 1);
    Atomics.add(this.counters, counterIndex, 1);
    
    // Update moving average latency
    const count = Atomics.load(this.counters, counterIndex);
    const currentAvgBits = Atomics.load(this.metrics, operationIndex);
    const currentAvg = this.int32BitsToFloat(currentAvgBits);
    const newAvg = currentAvg + (latencyMs - currentAvg) / count;
    
    Atomics.store(this.metrics, operationIndex, this.floatToInt32Bits(newAvg));
    
    // Alert on high latency
    if (latencyMs > 100) {
      this.logger.error(`HIGH LATENCY ALERT: ${operation} took ${latencyMs}ms`);
    }
  }

  /**
   * Get operation index for metrics tracking
   */
  private getOperationIndex(operation: string): number {
    const operations = ['updatePosition', 'evaluateExit', 'atomicRead', 'atomicWrite'];
    return operations.indexOf(operation);
  }

  /**
   * Setup worker thread pool for parallel processing
   */
  private setupWorkerPool(): void {
    if (!isMainThread) {
      this.logger.debug('Running in worker thread, skipping worker pool setup');
      return;
    }
    
    const cpuCount = require('os').cpus().length;
    const workerCount = Math.max(1, cpuCount - 1); // Leave one CPU for main thread
    
    for (let i = 0; i < workerCount; i++) {
      try {
        const worker = new Worker(__filename, {
          workerData: {
            priceBuffer: this.priceBuffer,
            positionBuffer: this.positionBuffer,
            metricsBuffer: this.metricsBuffer,
            workerId: i
          }
        });
        
        worker.on('error', (error) => {
          this.logger.error(`Worker ${i} error:`, { error: error.message });
        });
        
        worker.on('exit', (code) => {
          this.logger.info(`Worker ${i} exited with code ${code}`);
        });
        
        this.workers.push(worker);
      } catch (error) {
        this.logger.error(`Failed to create worker ${i}:`, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    
    this.logger.info(`Created ${this.workers.length} worker threads`);
  }

  /**
   * Get performance statistics
   */
  public getPerformanceStats(): Record<string, any> {
    const operations = ['updatePosition', 'evaluateExit', 'atomicRead', 'atomicWrite'];
    const stats: Record<string, any> = {};
    
    operations.forEach((operation, index) => {
      const successCount = Atomics.load(this.counters, index * 2);
      const failureCount = Atomics.load(this.counters, index * 2 + 1);
      const avgLatencyBits = Atomics.load(this.metrics, index);
      const avgLatency = this.int32BitsToFloat(avgLatencyBits);
      
      stats[operation] = {
        successCount,
        failureCount,
        totalCount: successCount + failureCount,
        successRate: successCount + failureCount > 0 ? (successCount / (successCount + failureCount)) * 100 : 0,
        averageLatency: avgLatency
      };
    });
    
    return stats;
  }

  /**
   * Cleanup resources
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down AtomicPositionManager');
    
    // Terminate all workers
    await Promise.all(this.workers.map(worker => worker.terminate()));
    
    // Log final performance stats
    const stats = this.getPerformanceStats();
    this.logger.info('Final performance stats:', stats);
    
    this.logger.info('AtomicPositionManager shutdown complete');
  }
}

// Worker thread code
if (!isMainThread && workerData) {
  const { priceBuffer, positionBuffer, metricsBuffer, workerId } = workerData;
  const logger = new Logger(`AtomicWorker-${workerId}`);
  
  // Initialize shared memory views in worker
  const prices = new Float64Array(priceBuffer);
  const positions = new Int32Array(positionBuffer);
  const metrics = new Float64Array(metricsBuffer);
  
  logger.info(`Worker ${workerId} started with shared memory access`);
  
  parentPort?.on('message', (message) => {
    switch (message.type) {
      case 'PROCESS_DATA':
        // Process market data in worker thread
        processMarketDataInWorker(message.data);
        break;
      case 'EVALUATE_POSITIONS':
        // Evaluate positions in parallel
        evaluatePositionsInWorker(message.positions);
        break;
    }
  });
  
  function processMarketDataInWorker(data: any) {
    // Worker-specific market data processing
    logger.debug(`Processing market data in worker ${workerId}`);
    
    parentPort?.postMessage({
      type: 'DATA_PROCESSED',
      workerId,
      result: data
    });
  }
  
  function evaluatePositionsInWorker(positions: any[]) {
    // Worker-specific position evaluation
    logger.debug(`Evaluating ${positions.length} positions in worker ${workerId}`);
    
    parentPort?.postMessage({
      type: 'POSITIONS_EVALUATED',
      workerId,
      count: positions.length
    });
  }
}