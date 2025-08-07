/**
 * Lock-Free Market Data Processor
 * 
 * High-performance market data processing using lock-free algorithms
 * and atomic operations for sub-millisecond price updates.
 */

import { Logger } from '../utils/logger';
import { TokenPrice } from '../types';

export interface MarketDataPoint {
  tokenAddress: string;
  price: number;
  volume: number;
  timestamp: number;
  source: string;
}

export interface LockFreeQueueStats {
  enqueueCount: number;
  dequeueCount: number;
  droppedCount: number;
  averageLatency: number;
  queueUtilization: number;
}

/**
 * Lock-free circular queue for high-frequency market data
 */
export class LockFreeMarketQueue {
  private logger: Logger;
  private dataBuffer: SharedArrayBuffer;
  private metadataBuffer: SharedArrayBuffer;
  
  // Queue data arrays
  private priceData: Int32Array; // Store floats as int32 bits for atomic operations
  private volumeData: Int32Array; // Store floats as int32 bits for atomic operations
  private timestampData: Int32Array; // Store timestamps as int32 for atomic operations
  private tokenHashData: Int32Array;
  
  // Queue control
  private head: Int32Array;
  private tail: Int32Array;
  private size: number;
  
  // Performance tracking
  private stats: Int32Array;
  private latencySum: Int32Array; // Store latency sum as int32 bits
  
  private readonly STATS_ENQUEUE = 0;
  private readonly STATS_DEQUEUE = 1;
  private readonly STATS_DROPPED = 2;
  private readonly STATS_LATENCY_COUNT = 3;

  constructor(queueSize: number = 8192) {
    this.logger = new Logger('LockFreeMarketQueue');
    this.size = queueSize;
    
    // Allocate shared memory
    const dataSize = queueSize * 32; // 8+8+8+4 bytes per entry, padded
    const metadataSize = 1024; // Control and stats data
    
    this.dataBuffer = new SharedArrayBuffer(dataSize);
    this.metadataBuffer = new SharedArrayBuffer(metadataSize);
    
    // Initialize data arrays
    this.priceData = new Int32Array(this.dataBuffer, 0, queueSize);
    this.volumeData = new Int32Array(this.dataBuffer, queueSize * 4, queueSize);
    this.timestampData = new Int32Array(this.dataBuffer, queueSize * 8, queueSize);
    this.tokenHashData = new Int32Array(this.dataBuffer, queueSize * 12, queueSize);
    
    // Initialize control arrays
    this.head = new Int32Array(this.metadataBuffer, 0, 1);
    this.tail = new Int32Array(this.metadataBuffer, 4, 1);
    this.stats = new Int32Array(this.metadataBuffer, 16, 10);
    this.latencySum = new Int32Array(this.metadataBuffer, 64, 5);
    
    // Initialize values
    Atomics.store(this.head, 0, 0);
    Atomics.store(this.tail, 0, 0);
    
    this.logger.info(`Initialized lock-free queue with size ${queueSize}`);
  }

  /**
   * Enqueue market data using lock-free algorithm
   * Target: <0.1ms latency
   */
  public enqueueMarketData(data: MarketDataPoint): boolean {
    const startTime = process.hrtime.bigint();
    
    try {
      const tokenHash = this.hashToken(data.tokenAddress);
      let currentTail: number;
      let nextTail: number;
      let attempts = 0;
      const maxAttempts = 1000; // Prevent infinite loops
      
      // Lock-free enqueue with CAS
      do {
        if (attempts++ > maxAttempts) {
          Atomics.add(this.stats, this.STATS_DROPPED, 1);
          this.logger.warning(`Queue enqueue failed after ${maxAttempts} attempts`);
          return false;
        }
        
        currentTail = Atomics.load(this.tail, 0);
        nextTail = (currentTail + 1) % this.size;
        
        // Check if queue is full
        const currentHead = Atomics.load(this.head, 0);
        if (nextTail === currentHead) {
          Atomics.add(this.stats, this.STATS_DROPPED, 1);
          return false; // Queue full
        }
        
      } while (
        Atomics.compareExchange(this.tail, 0, currentTail, nextTail) !== currentTail
      );
      
      // Store data atomically (convert floats to int32 bits)
      Atomics.store(this.priceData, currentTail, this.floatToInt32Bits(data.price));
      Atomics.store(this.volumeData, currentTail, this.floatToInt32Bits(data.volume));
      Atomics.store(this.timestampData, currentTail, data.timestamp);
      Atomics.store(this.tokenHashData, currentTail, tokenHash);
      
      // Update statistics
      Atomics.add(this.stats, this.STATS_ENQUEUE, 1);
      
      const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
      this.updateLatencyStats(latency);
      
      // Notify waiting consumers
      Atomics.notify(this.tail, 0, Number.MAX_SAFE_INTEGER);
      
      if (latency > 0.5) {
        this.logger.warning(`Slow enqueue operation: ${latency.toFixed(3)}ms`);
      }
      
      return true;
      
    } catch (error) {
      Atomics.add(this.stats, this.STATS_DROPPED, 1);
      this.logger.error(`Enqueue error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Dequeue market data using lock-free algorithm
   * Target: <0.1ms latency
   */
  public dequeueMarketData(): MarketDataPoint | null {
    const startTime = process.hrtime.bigint();
    
    try {
      let currentHead: number;
      let nextHead: number;
      let attempts = 0;
      const maxAttempts = 1000;
      
      // Lock-free dequeue with CAS
      do {
        if (attempts++ > maxAttempts) {
          this.logger.warning(`Queue dequeue failed after ${maxAttempts} attempts`);
          return null;
        }
        
        currentHead = Atomics.load(this.head, 0);
        
        // Check if queue is empty
        const currentTail = Atomics.load(this.tail, 0);
        if (currentHead === currentTail) {
          return null; // Queue empty
        }
        
        nextHead = (currentHead + 1) % this.size;
        
      } while (
        Atomics.compareExchange(this.head, 0, currentHead, nextHead) !== currentHead
      );
      
      // Read data atomically (convert int32 bits back to floats)
      const priceBits = Atomics.load(this.priceData, currentHead);
      const volumeBits = Atomics.load(this.volumeData, currentHead);
      const timestamp = Atomics.load(this.timestampData, currentHead);
      const tokenHash = Atomics.load(this.tokenHashData, currentHead);
      
      const price = this.int32BitsToFloat(priceBits);
      const volume = this.int32BitsToFloat(volumeBits);
      
      // Update statistics
      Atomics.add(this.stats, this.STATS_DEQUEUE, 1);
      
      const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
      this.updateLatencyStats(latency);
      
      return {
        tokenAddress: this.unhashToken(tokenHash),
        price,
        volume,
        timestamp,
        source: 'lock-free-queue'
      };
      
    } catch (error) {
      this.logger.error(`Dequeue error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Wait for data with timeout
   */
  public async waitForData(timeoutMs: number = 1000): Promise<MarketDataPoint | null> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const data = this.dequeueMarketData();
      if (data) {
        return data;
      }
      
      // Wait for notification or short timeout
      const currentTail = Atomics.load(this.tail, 0);
      try {
        Atomics.wait(this.tail, 0, currentTail, Math.min(10, timeoutMs - (Date.now() - startTime)));
      } catch (error) {
        // Wait operation may not be supported in all environments
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    
    return null;
  }

  /**
   * Batch dequeue for processing multiple items at once
   */
  public dequeueBatch(maxItems: number = 100): MarketDataPoint[] {
    const batch: MarketDataPoint[] = [];
    
    for (let i = 0; i < maxItems; i++) {
      const data = this.dequeueMarketData();
      if (!data) break;
      batch.push(data);
    }
    
    return batch;
  }

  /**
   * Get queue statistics
   */
  public getStats(): LockFreeQueueStats {
    const enqueueCount = Atomics.load(this.stats, this.STATS_ENQUEUE);
    const dequeueCount = Atomics.load(this.stats, this.STATS_DEQUEUE);
    const droppedCount = Atomics.load(this.stats, this.STATS_DROPPED);
    const latencyCount = Atomics.load(this.stats, this.STATS_LATENCY_COUNT);
    const latencySumBits = Atomics.load(this.latencySum, 0);
    const latencySum = this.int32BitsToFloat(latencySumBits);
    
    const currentHead = Atomics.load(this.head, 0);
    const currentTail = Atomics.load(this.tail, 0);
    const queueLength = (currentTail - currentHead + this.size) % this.size;
    
    return {
      enqueueCount,
      dequeueCount,
      droppedCount,
      averageLatency: latencyCount > 0 ? latencySum / latencyCount : 0,
      queueUtilization: (queueLength / this.size) * 100
    };
  }

  /**
   * Check if queue is near capacity
   */
  public isNearCapacity(threshold: number = 0.8): boolean {
    const stats = this.getStats();
    return stats.queueUtilization > threshold * 100;
  }

  /**
   * Clear all data from queue
   */
  public clear(): void {
    Atomics.store(this.head, 0, 0);
    Atomics.store(this.tail, 0, 0);
    
    // Reset statistics
    for (let i = 0; i < this.stats.length; i++) {
      Atomics.store(this.stats, i, 0);
    }
    for (let i = 0; i < this.latencySum.length; i++) {
      Atomics.store(this.latencySum, i, 0);
    }
    
    this.logger.info('Queue cleared');
  }

  /**
   * Update latency statistics atomically
   */
  private updateLatencyStats(latencyMs: number): void {
    Atomics.add(this.stats, this.STATS_LATENCY_COUNT, 1);
    
    // Update sum for average calculation
    let currentSum: number;
    let newSum: number;
    
    do {
      const currentSumBits = Atomics.load(this.latencySum, 0);
      currentSum = this.int32BitsToFloat(currentSumBits);
      newSum = currentSum + latencyMs;
      const newSumBits = this.floatToInt32Bits(newSum);
    } while (
      Atomics.compareExchange(this.latencySum, 0, this.floatToInt32Bits(currentSum), this.floatToInt32Bits(newSum)) !== this.floatToInt32Bits(currentSum)
    );
  }

  /**
   * Simple hash function for token addresses
   */
  private hashToken(tokenAddress: string): number {
    let hash = 0;
    for (let i = 0; i < tokenAddress.length; i++) {
      const char = tokenAddress.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Reverse hash to token address (simplified - in production use a lookup table)
   */
  private unhashToken(hash: number): string {
    // In a real implementation, maintain a hash -> address mapping
    return `token-${hash}`;
  }

  /**
   * Convert float to int32 bits for atomic operations
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
}

/**
 * High-performance market data processor using multiple lock-free queues
 */
export class LockFreeMarketDataProcessor {
  private logger: Logger;
  private queues: Map<string, LockFreeMarketQueue> = new Map();
  private globalQueue: LockFreeMarketQueue;
  private processors: NodeJS.Timeout[] = [];
  private isRunning = false;
  
  // Performance tracking
  private totalProcessed = 0;
  private totalLatency = 0;
  private highLatencyCount = 0;

  constructor(private options: {
    queueSize?: number;
    processingIntervalMs?: number;
    maxLatencyMs?: number;
  } = {}) {
    this.logger = new Logger('LockFreeMarketDataProcessor');
    
    const {
      queueSize = 8192,
      processingIntervalMs = 1,
      maxLatencyMs = 50
    } = options;
    
    this.globalQueue = new LockFreeMarketQueue(queueSize);
    
    this.logger.info(`Initialized with queue size ${queueSize}, interval ${processingIntervalMs}ms`);
  }

  /**
   * Start processing market data
   */
  public start(): void {
    if (this.isRunning) {
      this.logger.warning('Processor already running');
      return;
    }
    
    this.isRunning = true;
    this.startProcessingLoop();
    this.startMonitoring();
    
    this.logger.info('Market data processor started');
  }

  /**
   * Stop processing
   */
  public stop(): void {
    this.isRunning = false;
    
    this.processors.forEach(timer => clearTimeout(timer));
    this.processors.length = 0;
    
    this.logger.info('Market data processor stopped');
  }

  /**
   * Process incoming market data
   */
  public async processMarketData(data: MarketDataPoint): Promise<boolean> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Enqueue to global queue
      const globalQueued = this.globalQueue.enqueueMarketData(data);
      
      // Enqueue to token-specific queue
      const tokenQueue = this.getOrCreateTokenQueue(data.tokenAddress);
      const tokenQueued = tokenQueue.enqueueMarketData(data);
      
      const processingTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      
      // Update statistics
      this.totalProcessed++;
      this.totalLatency += processingTime;
      
      if (processingTime > (this.options.maxLatencyMs || 50)) {
        this.highLatencyCount++;
        this.logger.warning(`High latency market data processing: ${processingTime.toFixed(3)}ms`);
      }
      
      return globalQueued && tokenQueued;
      
    } catch (error) {
      this.logger.error(`Market data processing error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Get latest price for token
   */
  public getLatestPrice(tokenAddress: string): number | null {
    const queue = this.queues.get(tokenAddress);
    if (!queue) return null;
    
    const data = queue.dequeueMarketData();
    return data ? data.price : null;
  }

  /**
   * Get performance statistics
   */
  public getPerformanceStats(): {
    totalProcessed: number;
    averageLatency: number;
    highLatencyPercentage: number;
    queueStats: Record<string, LockFreeQueueStats>;
  } {
    const queueStats: Record<string, LockFreeQueueStats> = {
      global: this.globalQueue.getStats()
    };
    
    this.queues.forEach((queue, token) => {
      queueStats[token] = queue.getStats();
    });
    
    return {
      totalProcessed: this.totalProcessed,
      averageLatency: this.totalProcessed > 0 ? this.totalLatency / this.totalProcessed : 0,
      highLatencyPercentage: this.totalProcessed > 0 ? (this.highLatencyCount / this.totalProcessed) * 100 : 0,
      queueStats
    };
  }

  /**
   * Get or create token-specific queue
   */
  private getOrCreateTokenQueue(tokenAddress: string): LockFreeMarketQueue {
    let queue = this.queues.get(tokenAddress);
    
    if (!queue) {
      queue = new LockFreeMarketQueue(this.options.queueSize);
      this.queues.set(tokenAddress, queue);
      this.logger.debug(`Created queue for token ${tokenAddress}`);
    }
    
    return queue;
  }

  /**
   * Start main processing loop
   */
  private startProcessingLoop(): void {
    const processLoop = async () => {
      if (!this.isRunning) return;
      
      try {
        // Process batch from global queue
        const batch = this.globalQueue.dequeueBatch(100);
        
        if (batch.length > 0) {
          await this.processBatch(batch);
        }
        
        // Schedule next iteration
        setTimeout(processLoop, this.options.processingIntervalMs || 1);
        
      } catch (error) {
        this.logger.error(`Processing loop error: ${error instanceof Error ? error.message : String(error)}`);
        
        // Restart processing after error
        if (this.isRunning) {
          setTimeout(processLoop, 10);
        }
      }
    };
    
    processLoop();
  }

  /**
   * Process batch of market data
   */
  private async processBatch(batch: MarketDataPoint[]): Promise<void> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Group by token for efficient processing
      const tokenGroups = new Map<string, MarketDataPoint[]>();
      
      batch.forEach(data => {
        const group = tokenGroups.get(data.tokenAddress) || [];
        group.push(data);
        tokenGroups.set(data.tokenAddress, group);
      });
      
      // Process each token group
      for (const [tokenAddress, dataPoints] of tokenGroups) {
        await this.processTokenData(tokenAddress, dataPoints);
      }
      
      const processingTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      
      if (processingTime > 10) {
        this.logger.warning(`Slow batch processing: ${processingTime.toFixed(2)}ms for ${batch.length} items`);
      }
      
    } catch (error) {
      this.logger.error(`Batch processing error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Process data for specific token
   */
  private async processTokenData(tokenAddress: string, dataPoints: MarketDataPoint[]): Promise<void> {
    // Sort by timestamp to ensure correct ordering
    dataPoints.sort((a, b) => a.timestamp - b.timestamp);
    
    // Process each data point
    for (const data of dataPoints) {
      // Update price feeds, trigger position evaluations, etc.
      // This would integrate with the main trading system
      this.logger.debug(`Processing ${tokenAddress}: $${data.price} volume: ${data.volume}`);
    }
  }

  /**
   * Start monitoring and alerts
   */
  private startMonitoring(): void {
    const monitorLoop = () => {
      if (!this.isRunning) return;
      
      try {
        const stats = this.getPerformanceStats();
        
        // Check for performance issues
        if (stats.averageLatency > 10) {
          this.logger.warning(`High average latency: ${stats.averageLatency.toFixed(2)}ms`);
        }
        
        if (stats.highLatencyPercentage > 5) {
          this.logger.warning(`High latency percentage: ${stats.highLatencyPercentage.toFixed(1)}%`);
        }
        
        // Check queue utilization
        Object.entries(stats.queueStats).forEach(([name, queueStats]) => {
          if (queueStats.queueUtilization > 80) {
            this.logger.warning(`Queue ${name} high utilization: ${queueStats.queueUtilization.toFixed(1)}%`);
          }
        });
        
        // Schedule next monitoring check
        setTimeout(monitorLoop, 5000); // Every 5 seconds
        
      } catch (error) {
        this.logger.error(`Monitoring error: ${error instanceof Error ? error.message : String(error)}`);
        
        if (this.isRunning) {
          setTimeout(monitorLoop, 5000);
        }
      }
    };
    
    monitorLoop();
  }
}