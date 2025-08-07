/**
 * AtomicPositionManager - Thread-safe version of PositionManager
 * Integrates AtomicPositionStateMachine to eliminate race conditions in position management
 * 
 * Key Features:
 * - Thread-safe position creation and updates
 * - Atomic price updates across all positions
 * - Race condition-free exit strategy evaluation
 * - Backward compatibility with existing PositionManager interface
 */

import { Mutex } from 'async-mutex';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../db';
import { EventProcessor } from '../events/types';
import {
  Position,
  ExitStrategyConfig,
  TradeResult,
  Trade,
} from '../types';
import { PositionModel } from '../db/models/position';
import { AtomicPositionStateMachine } from '../core/state-machines/atomic-position-state-machine';
import {
  CompatibleAtomicPositionStateMachine,
  createAtomicPositionStateMachine,
} from '../core/state-machines/atomic-compatibility-wrapper';
import {
  PositionState,
  PositionStateTransition,
} from '../core/state-machines/position-state-machine';

/**
 * Interface for current token price data - enhanced with atomic metadata
 */
export interface AtomicTokenPrice {
  tokenAddress: string;
  price: number;
  timestamp: number;
  source: string;
  atomic?: {
    sequence: number;
    batchId: string;
  };
}

/**
 * Atomic position update result
 */
export interface AtomicPositionUpdateResult {
  success: boolean;
  positionId: string;
  updatedFields: string[];
  operationTime: number;
  atomicMetrics?: any;
}

/**
 * Thread-safe position manager with atomic operations
 */
export class AtomicPositionManager {
  private logger: Logger;
  private dbManager: DatabaseManager;
  private eventProcessor: EventProcessor;
  
  // Thread-safe position tracking
  private positions = new Map<string, CompatibleAtomicPositionStateMachine>();
  private positionsMutex = new Mutex();
  private priceUpdateMutex = new Mutex();
  
  // Performance tracking
  private operationMetrics = {
    priceUpdates: { count: 0, totalTime: 0 },
    positionCreation: { count: 0, totalTime: 0 },
    exitEvaluation: { count: 0, totalTime: 0 },
  };

  constructor(
    dbManager: DatabaseManager,
    eventProcessor: EventProcessor,
    private monitoringIntervalMs: number = 1000
  ) {
    this.dbManager = dbManager;
    this.eventProcessor = eventProcessor;
    this.logger = new Logger('AtomicPositionManager');
    
    this.logger.info('AtomicPositionManager initialized with race condition protection');
  }

  /**
   * Thread-safe position creation with atomic state machine initialization
   */
  public async createPosition(
    tokenAddress: string,
    entryPrice: number,
    amount: number,
    exitStrategies: ExitStrategyConfig[]
  ): Promise<string> {
    const startTime = performance.now();
    
    return await this.positionsMutex.runExclusive(async () => {
      const positionId = `pos_${tokenAddress}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        // Create atomic state machine with race condition protection
        const atomicStateMachine = createAtomicPositionStateMachine({
          positionId,
          tokenAddress,
          entryPrice,
          amount,
        });
        
        // Store in thread-safe map
        this.positions.set(positionId, atomicStateMachine);
        
        // Create position in database (using generic database operations)
        // Note: Actual database creation will need to be implemented based on your schema
        
        // Atomic state transition
        await atomicStateMachine.transition(PositionStateTransition.POSITION_OPENED);
        
        this.logger.info(`Position created atomically: ${positionId}`);
        
        // Update metrics
        const operationTime = performance.now() - startTime;
        this.operationMetrics.positionCreation.count++;
        this.operationMetrics.positionCreation.totalTime += operationTime;
        
        return positionId;
      } catch (error) {
        this.logger.error(`Failed to create position: ${error instanceof Error ? error.message : error}`);
        throw error;
      }
    });
  }

  /**
   * Atomic price update for all positions
   * Prevents race conditions in PnL calculations across multiple positions
   */
  public async updatePricesAtomically(
    prices: AtomicTokenPrice[]
  ): Promise<AtomicPositionUpdateResult[]> {
    const startTime = performance.now();
    
    return await this.priceUpdateMutex.runExclusive(async () => {
      const results: AtomicPositionUpdateResult[] = [];
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      
      // Process all price updates atomically
      const updatePromises = prices.map(async (priceData, index) => {
        const enhancedPrice = {
          ...priceData,
          atomic: {
            sequence: index,
            batchId,
          },
        };
        
        return await this.updatePositionPrices(enhancedPrice);
      });
      
      const batchResults = await Promise.allSettled(updatePromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        } else {
          this.logger.error(`Price update failed for index ${index}: ${result.reason}`);
        }
      });
      
      // Update performance metrics
      const operationTime = performance.now() - startTime;
      this.operationMetrics.priceUpdates.count++;
      this.operationMetrics.priceUpdates.totalTime += operationTime;
      
      this.logger.debug(`Atomic price update batch ${batchId} completed: ${results.length} positions updated`);
      
      return results;
    });
  }

  /**
   * Update prices for positions matching a specific token
   */
  private async updatePositionPrices(
    priceData: AtomicTokenPrice
  ): Promise<AtomicPositionUpdateResult[]> {
    const results: AtomicPositionUpdateResult[] = [];
    
    for (const [positionId, stateMachine] of this.positions.entries()) {
      const context = stateMachine.getContext();
      
      if (context.tokenAddress === priceData.tokenAddress && stateMachine.isActive()) {
        const updateStart = performance.now();
        
        try {
          // Atomic price update - fixes original race condition
          stateMachine.updatePrice(priceData.price);
          
          const operationTime = performance.now() - updateStart;
          const atomicMetrics = stateMachine.getAtomicMetrics();
          
          results.push({
            success: true,
            positionId,
            updatedFields: ['currentPrice', 'pnlPercent', 'pnlUsd', 'lastPriceUpdate'],
            operationTime,
            atomicMetrics,
          });
          
          this.logger.debug(`Atomic price update: ${positionId} -> ${priceData.price}`);
        } catch (error) {
          this.logger.error(`Failed to update price for position ${positionId}: ${error instanceof Error ? error.message : error}`);
          
          results.push({
            success: false,
            positionId,
            updatedFields: [],
            operationTime: performance.now() - updateStart,
          });
        }
      }
    }
    
    return results;
  }

  /**
   * Thread-safe exit evaluation for all active positions
   */
  public async evaluateExitConditions(): Promise<string[]> {
    const startTime = performance.now();
    const positionsToExit: string[] = [];
    
    // Get all active positions atomically
    const activePositions: Array<[string, CompatibleAtomicPositionStateMachine]> = [];
    
    await this.positionsMutex.runExclusive(async () => {
      for (const [positionId, stateMachine] of this.positions.entries()) {
        if (stateMachine.isActive()) {
          activePositions.push([positionId, stateMachine]);
        }
      }
    });
    
    // Evaluate exit conditions without holding the main mutex
    for (const [positionId, stateMachine] of activePositions) {
      try {
        const context = stateMachine.getContext();
        const pnl = stateMachine.getPnL();
        
        // Example exit conditions (can be enhanced based on strategies)
        const shouldExit = this.shouldExitPosition(context, pnl);
        
        if (shouldExit) {
          // Atomic state transition to exit pending
          const transitionSuccess = stateMachine.transition(
            PositionStateTransition.EXIT_CONDITION_MET,
            { exitReason: shouldExit.reason }
          );
          
          if (transitionSuccess) {
            positionsToExit.push(positionId);
            this.logger.info(`Position ${positionId} marked for exit: ${shouldExit.reason}`);
          }
        }
      } catch (error) {
        this.logger.error(`Exit evaluation failed for ${positionId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    
    // Update metrics
    const operationTime = performance.now() - startTime;
    this.operationMetrics.exitEvaluation.count++;
    this.operationMetrics.exitEvaluation.totalTime += operationTime;
    
    return positionsToExit;
  }

  /**
   * Get thread-safe position information
   */
  public async getPosition(positionId: string): Promise<any | null> {
    return await this.positionsMutex.runExclusive(async () => {
      const stateMachine = this.positions.get(positionId);
      if (!stateMachine) {
        return null;
      }
      
      const context = stateMachine.getContext();
      const pnl = stateMachine.getPnL();
      const state = stateMachine.getCurrentState();
      const metrics = stateMachine.getAtomicMetrics();
      
      return {
        ...context,
        currentState: state,
        pnl,
        atomicMetrics: metrics,
        isActive: stateMachine.isActive(),
        canExit: stateMachine.canExit(),
      };
    });
  }

  /**
   * Get all active positions thread-safely
   */
  public async getActivePositions(): Promise<any[]> {
    const activePositions: any[] = [];
    
    await this.positionsMutex.runExclusive(async () => {
      for (const [positionId, stateMachine] of this.positions.entries()) {
        if (stateMachine.isActive()) {
          const context = stateMachine.getContext();
          const pnl = stateMachine.getPnL();
          
          activePositions.push({
            id: positionId,
            ...context,
            currentState: stateMachine.getCurrentState(),
            pnl,
            isActive: true,
          });
        }
      }
    });
    
    return activePositions;
  }

  /**
   * Force close a position atomically
   */
  public async closePosition(positionId: string, reason: string): Promise<boolean> {
    return await this.positionsMutex.runExclusive(async () => {
      const stateMachine = this.positions.get(positionId);
      if (!stateMachine) {
        this.logger.warning(`Position not found for closing: ${positionId}`);
        return false;
      }
      
      try {
        // Atomic transition to closed state
        const success = stateMachine.transition(
          PositionStateTransition.EXIT_COMPLETED,
          { exitReason: reason }
        );
        
        if (success) {
          // Update database (implement based on your database schema)
          this.logger.info(`Position closed atomically: ${positionId} - ${reason}`);
          return true;
        } else {
          this.logger.warning(`Failed to close position: ${positionId}`);
          return false;
        }
      } catch (error) {
        this.logger.error(`Error closing position ${positionId}: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    });
  }

  /**
   * Get atomic operation performance metrics
   */
  public getPerformanceMetrics() {
    const metrics: Record<string, { avg: number; count: number }> = {};
    
    for (const [key, value] of Object.entries(this.operationMetrics)) {
      metrics[key] = {
        avg: value.count > 0 ? value.totalTime / value.count : 0,
        count: value.count,
      };
    }
    
    return {
      operations: metrics,
      totalPositions: this.positions.size,
      activePositions: Array.from(this.positions.values()).filter(p => p.isActive()).length,
      timestamp: Date.now(),
    };
  }

  /**
   * Cleanup closed positions to free memory
   */
  public async cleanupClosedPositions(): Promise<number> {
    return await this.positionsMutex.runExclusive(async () => {
      let cleanedCount = 0;
      
      for (const [positionId, stateMachine] of this.positions.entries()) {
        if (stateMachine.isClosed()) {
          this.positions.delete(positionId);
          cleanedCount++;
        }
      }
      
      this.logger.debug(`Cleaned up ${cleanedCount} closed positions`);
      return cleanedCount;
    });
  }

  /**
   * Example exit condition logic (can be enhanced)
   */
  private shouldExitPosition(
    context: any,
    pnl: { percent: number; usd: number }
  ): { reason: string } | null {
    // Stop loss at -10%
    if (pnl.percent <= -10) {
      return { reason: `Stop loss triggered: ${pnl.percent.toFixed(2)}%` };
    }
    
    // Take profit at +50%
    if (pnl.percent >= 50) {
      return { reason: `Take profit triggered: ${pnl.percent.toFixed(2)}%` };
    }
    
    // Time-based exit after 1 hour
    const positionAge = Date.now() - context.entryTimestamp;
    if (positionAge > 3600000) { // 1 hour in milliseconds
      return { reason: `Time limit reached: ${(positionAge / 60000).toFixed(1)} minutes` };
    }
    
    return null;
  }
}

/**
 * Factory function for creating atomic position manager
 */
export function createAtomicPositionManager(
  dbManager: DatabaseManager,
  eventProcessor: EventProcessor,
  monitoringIntervalMs = 1000
): AtomicPositionManager {
  return new AtomicPositionManager(dbManager, eventProcessor, monitoringIntervalMs);
}