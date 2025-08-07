/**
 * Position Manager Integration with Atomic State Machines
 * 
 * This file demonstrates how to integrate the AtomicPositionStateMachine
 * with the existing PositionManager for improved concurrency and performance.
 */

import { Logger } from '../../utils/logger';
import { DatabaseManager } from '../../db';
import { EventProcessor } from '../../events/types';
import { PositionModel } from '../../db/models/position';
import { TokenPrice, PositionExitRequest, ExitEvaluationResult, PerformanceMetrics } from '../../types';
import { AtomicPositionStateMachine } from './atomic-position-state-machine';
import { PositionStateTransition } from './position-state-machine';

/**
 * Enhanced PositionManager with Atomic State Machine Integration
 */
export class AtomicPositionManager {
  private logger: Logger;
  private db: DatabaseManager;
  private eventManager: EventProcessor;
  private stateMachines = new Map<string, AtomicPositionStateMachine>();
  private performanceMetrics = new Map<string, PerformanceMetrics[]>();
  
  // Performance monitoring
  private monitoringTimer?: NodeJS.Timeout;
  private metricsCollectionInterval = 30000; // 30 seconds
  
  constructor(
    db: DatabaseManager,
    eventManager: EventProcessor,
    private options: {
      enablePerformanceMonitoring?: boolean;
      metricsRetentionMinutes?: number;
      alertOnSlowOperations?: boolean;
    } = {}
  ) {
    this.db = db;
    this.eventManager = eventManager;
    this.logger = new Logger('AtomicPositionManager');
    
    this.options = {
      enablePerformanceMonitoring: true,
      metricsRetentionMinutes: 60,
      alertOnSlowOperations: true,
      ...options,
    };
    
    this.setupEventListeners();
    this.startPerformanceMonitoring();
  }
  
  /**
   * Create a new position with atomic state machine
   */
  public async createPosition(
    tokenAddress: string,
    entryPrice: number,
    amount: number,
    entryTradeId: string,
    exitStrategy: any
  ): Promise<PositionModel> {
    this.logger.info(`Creating atomic position for token ${tokenAddress}`);
    
    // Create traditional position model
    const position = PositionModel.create(
      tokenAddress,
      entryPrice,
      amount,
      entryTradeId,
      exitStrategy
    );
    
    // Create atomic state machine
    const stateMachine = new AtomicPositionStateMachine({
      positionId: position.id,
      tokenAddress,
      entryPrice,
      amount,
    });
    
    this.stateMachines.set(position.id, stateMachine);
    
    // Start monitoring this position atomically
    await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
    
    await this.db.addPosition(position);
    
    // Emit position update event
    this.eventManager.emit('positionUpdate', {
      position,
      updateType: 'CREATED',
      reason: 'New atomic position created',
      timestamp: Date.now(),
    } as any);
    
    this.logger.info(`Atomic position created: ${position.id}`);
    return position;
  }
  
  /**
   * Update token price for all relevant positions atomically
   */
  public async updateTokenPrice(tokenPrice: TokenPrice): Promise<void> {
    const startTime = process.hrtime.bigint();
    let updatedPositions = 0;
    
    // Update all positions for this token in parallel
    const updatePromises: Promise<void>[] = [];
    
    for (const [positionId, stateMachine] of this.stateMachines) {
      const context = await stateMachine.getContext();
      
      if (context.tokenAddress === tokenPrice.tokenAddress) {
        // Atomic price update (non-blocking)
        stateMachine.updatePrice(tokenPrice.price);
        updatedPositions++;
        
        // Check for exit conditions asynchronously
        updatePromises.push(this.evaluatePositionExit(positionId, stateMachine));
      }
    }
    
    // Wait for all exit evaluations to complete
    Promise.all(updatePromises).catch(error => {
      this.logger.error('Error in parallel exit evaluations:', error);
    });
    
    const latency = Number(process.hrtime.bigint() - startTime) / 1000000;
    
    this.logger.debug(
      `Updated ${updatedPositions} positions for ${tokenPrice.tokenAddress} in ${latency.toFixed(2)}ms`
    );
    
    // Alert on slow price updates
    if (latency > 10) {
      this.logger.warn(`Slow price update: ${latency}ms for ${updatedPositions} positions`);
    }
  }
  
  /**
   * Evaluate position for exit conditions atomically
   */
  private async evaluatePositionExit(
    positionId: string,
    stateMachine: AtomicPositionStateMachine
  ): Promise<void> {
    try {
      const context = await stateMachine.getContext();
      const priceData = await stateMachine.getAtomicPriceData();
      
      // Get position from database for exit strategy evaluation
      const position = await this.db.getPosition(positionId);
      if (!position || position.status !== 'OPEN') {
        return;
      }
      
      // Evaluate exit conditions using atomic price data
      const exitResult = this.evaluateExitConditions(
        new PositionModel(position),
        {
          tokenAddress: context.tokenAddress,
          price: priceData.price,
          timestamp: priceData.timestamp,
          source: 'atomic',
        }
      );
      
      if (exitResult.shouldExit) {
        this.logger.info(
          `Atomic exit condition met for position ${positionId}: ${exitResult.reason}`
        );
        
        await this.processAtomicExitRequest({
          positionId,
          reason: exitResult.reason,
          urgency: exitResult.urgency,
          targetPrice: exitResult.expectedPrice,
          partialExitPercentage: exitResult.partialExitPercentage,
        });
      }
    } catch (error) {
      this.logger.error(`Error evaluating position ${positionId}:`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  
  /**
   * Process exit request with atomic state transitions
   */
  public async processAtomicExitRequest(exitRequest: PositionExitRequest): Promise<boolean> {
    const stateMachine = this.stateMachines.get(exitRequest.positionId);
    if (!stateMachine) {
      this.logger.error(`No state machine found for position ${exitRequest.positionId}`);
      return false;
    }
    
    try {
      // Atomic transition to exit pending state
      const success = await stateMachine.transition(
        PositionStateTransition.EXIT_CONDITION_MET,
        {
          exitReason: exitRequest.reason,
        }
      );
      
      if (success) {
        const context = await stateMachine.getContext();
        
        // Emit trade decision event for exit execution
        this.eventManager.emit('tradeDecision', {
          shouldTrade: true,
          targetToken: context.tokenAddress,
          baseToken: 'USDC',
          poolAddress: '',
          tradeAmountUsd: 0, // Will be calculated by executor
          expectedAmountOut: context.amount,
          price: exitRequest.targetPrice,
          reason: `Atomic position exit: ${exitRequest.reason}`,
          riskScore: 0,
        });
        
        this.logger.info(`Atomic exit request processed for position ${exitRequest.positionId}`);
      }
      
      return success;
    } catch (error) {
      this.logger.error(`Failed to process atomic exit request:`, { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  
  /**
   * Close position with atomic state machine
   */
  public async closePosition(
    positionId: string,
    exitTradeId: string,
    exitPrice: number,
    reason: string = 'Position closed'
  ): Promise<boolean> {
    const stateMachine = this.stateMachines.get(positionId);
    if (!stateMachine) {
      this.logger.error(`No state machine found for position ${positionId}`);
      return false;
    }
    
    try {
      // Get current context and PnL atomically
      const context = await stateMachine.getContext();
      const pnl = await stateMachine.getPnL();
      
      // Update database
      const success = await this.db.closePosition(
        positionId,
        exitTradeId,
        Date.now(),
        pnl.usd,
        pnl.percent
      );
      
      if (success) {
        // Atomic transition to closed state
        await stateMachine.transition(PositionStateTransition.EXIT_COMPLETED, {
          exitTimestamp: Date.now(),
          exitReason: reason,
        });
        
        // Emit position update event
        this.eventManager.emit('positionUpdate', {
          positionId,
          updateType: 'CLOSED',
          reason,
          timestamp: Date.now(),
          pnl: pnl,
        } as any);
        
        // Clean up state machine
        this.stateMachines.delete(positionId);
        
        this.logger.info(
          `Atomic position ${positionId} closed with P&L: ${pnl.percent.toFixed(2)}% (${pnl.usd.toFixed(2)} USD)`
        );
      }
      
      return success;
    } catch (error) {
      this.logger.error(`Failed to close atomic position:`, { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  
  /**
   * Get performance statistics for all positions
   */
  public getAtomicPerformanceStats(): Record<string, any> {
    const stats: Record<string, any> = {
      totalPositions: this.stateMachines.size,
      performanceSummary: {
        totalOperations: 0,
        averageLatency: 0,
        successRate: 0,
        operationBreakdown: {},
      },
      positionMetrics: {},
    };
    
    let totalOps = 0;
    let totalLatency = 0;
    let totalSuccesses = 0;
    const operationSummary: Record<string, any> = {};
    
    for (const [positionId, stateMachine] of this.stateMachines) {
      const metrics = stateMachine.getPerformanceMetrics();
      stats.positionMetrics[positionId] = metrics;
      
      // Aggregate metrics
      Object.entries(metrics).forEach(([operation, data]: [string, any]) => {
        if (!operationSummary[operation]) {
          operationSummary[operation] = {
            totalOps: 0,
            totalLatency: 0,
            totalSuccesses: 0,
          };
        }
        
        operationSummary[operation].totalOps += data.totalOperations;
        operationSummary[operation].totalLatency += data.averageLatency * data.totalOperations;
        operationSummary[operation].totalSuccesses += data.successCount;
        
        totalOps += data.totalOperations;
        totalLatency += data.averageLatency * data.totalOperations;
        totalSuccesses += data.successCount;
      });
    }
    
    // Calculate aggregated statistics
    stats.performanceSummary.totalOperations = totalOps;
    stats.performanceSummary.averageLatency = totalOps > 0 ? totalLatency / totalOps : 0;
    stats.performanceSummary.successRate = totalOps > 0 ? (totalSuccesses / totalOps) * 100 : 0;
    
    // Per-operation breakdown
    Object.entries(operationSummary).forEach(([operation, data]: [string, any]) => {
      stats.performanceSummary.operationBreakdown[operation] = {
        averageLatency: data.totalOps > 0 ? data.totalLatency / data.totalOps : 0,
        successRate: data.totalOps > 0 ? (data.totalSuccesses / data.totalOps) * 100 : 0,
        totalOperations: data.totalOps,
      };
    });
    
    return stats;
  }
  
  /**
   * Get all open positions with atomic state information
   */
  public async getOpenPositionsWithState(): Promise<Array<{
    position: PositionModel;
    state: string;
    context: any;
    priceData: any;
    performance: any;
  }>> {
    const openPositions = await this.db.getOpenPositions();
    const results: Array<{
      position: PositionModel;
      state: string;
      context: any;
      priceData: any;
      performance: any;
    }> = [];
    
    for (const position of openPositions) {
      const stateMachine = this.stateMachines.get(position.id);
      
      if (stateMachine) {
        results.push({
          position: new PositionModel(position),
          state: stateMachine.getCurrentState(),
          context: stateMachine.getContext(),
          priceData: stateMachine.getAtomicPriceData(),
          performance: stateMachine.getPerformanceMetrics(),
        });
      } else {
        // Handle positions without state machines (legacy)
        results.push({
          position: new PositionModel(position),
          state: 'UNKNOWN',
          context: null,
          priceData: null,
          performance: null,
        });
      }
    }
    
    return results;
  }
  
  /**
   * Start performance monitoring
   */
  private startPerformanceMonitoring(): void {
    if (!this.options.enablePerformanceMonitoring) {
      return;
    }
    
    this.monitoringTimer = setInterval(() => {
      this.collectPerformanceMetrics();
    }, this.metricsCollectionInterval);
    
    this.logger.info('Atomic position performance monitoring started');
  }
  
  /**
   * Collect and analyze performance metrics
   */
  private collectPerformanceMetrics(): void {
    const stats = this.getAtomicPerformanceStats();
    
    if (this.options.alertOnSlowOperations) {
      // Check for performance issues
      Object.entries(stats.performanceSummary.operationBreakdown).forEach(([operation, metrics]: [string, any]) => {
        const thresholds = {
          transition: 10,    // 10ms
          updatePrice: 1,    // 1ms
          contextUpdate: 5,  // 5ms
          atomicRead: 0.1,   // 0.1ms
        };
        
        const threshold = thresholds[operation as keyof typeof thresholds];
        if (threshold && metrics.averageLatency > threshold) {
          this.logger.warn(
            `PERFORMANCE ALERT: ${operation} average latency ${metrics.averageLatency.toFixed(2)}ms exceeds threshold ${threshold}ms`
          );
        }
        
        if (metrics.successRate < 99) {
          this.logger.error(
            `RELIABILITY ALERT: ${operation} success rate ${metrics.successRate.toFixed(1)}% below 99%`
          );
        }
      });
    }
    
    // Log summary statistics
    this.logger.debug(`Performance Summary: ${stats.performanceSummary.totalOperations} ops, ` +
      `${stats.performanceSummary.averageLatency.toFixed(2)}ms avg latency, ` +
      `${stats.performanceSummary.successRate.toFixed(1)}% success rate`);
  }
  
  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for system shutdown
    this.eventManager.on('systemStatus', statusEvent => {
      if (statusEvent.status === 'SHUTDOWN') {
        this.shutdown();
      }
    });
  }
  
  /**
   * Shutdown the atomic position manager
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down AtomicPositionManager');
    
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
    
    // Log final performance statistics
    const finalStats = this.getAtomicPerformanceStats();
    this.logger.info('Final atomic position performance stats:', finalStats);
    
    // Clean up state machines
    this.stateMachines.clear();
    
    this.logger.info('AtomicPositionManager shutdown complete');
  }
  
  /**
   * Placeholder for exit condition evaluation (same as original)
   */
  private evaluateExitConditions(
    position: PositionModel,
    currentPrice: TokenPrice
  ): ExitEvaluationResult {
    // This would use the same logic as the original PositionManager
    // but with atomic price data
    return {
      shouldExit: false,
      reason: 'No exit conditions met',
      urgency: 'LOW' as const,
    };
  }
}