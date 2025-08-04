/**
 * PositionManager handles all position-related operations including:
 * - Position tracking and monitoring
 * - Exit condition evaluation
 * - Exit strategy execution
 * - P&L calculations and record keeping
 */

import { DatabaseManager } from '../db';
import { EventProcessor } from '../events/types';
import { Logger } from '../utils/logger';
import { Position, ExitStrategyConfig, TradeResult, Trade } from '../types';
import { PositionModel } from '../db/models/position';
import {
  MultiConditionExitStrategy,
  TrailingStopLossExitStrategy,
  VolatilityBasedStopExitStrategy,
  VolumeBasedExitStrategy,
  SentimentAnalysisExitStrategy,
  CreatorMonitoringExitStrategy,
  PartialExitStrategy,
  AdvancedStrategyDataProvider,
} from './advanced-exit-strategies';

/**
 * Interface for current token price data
 */
export interface TokenPrice {
  tokenAddress: string;
  price: number;
  timestamp: number;
  source: string;
}

/**
 * Exit strategy evaluation result
 */
export interface ExitEvaluationResult {
  shouldExit: boolean;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  expectedPrice?: number;
  partialExitPercentage?: number;
}

/**
 * Position exit request
 */
export interface PositionExitRequest {
  positionId: string;
  reason: string;
  targetPrice?: number;
  partialExitPercentage?: number; // 0-100, for partial exits
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Interface for exit strategy implementations
 */
export interface ExitStrategy {
  readonly type: ExitStrategyConfig['type'];
  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult;
  getDescription(): string;
}

/**
 * Base abstract class for exit strategies
 */
export abstract class BaseExitStrategy implements ExitStrategy {
  constructor(protected config: ExitStrategyConfig) {}

  abstract get type(): ExitStrategyConfig['type'];
  abstract evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult;
  abstract getDescription(): string;
}

/**
 * Time-based exit strategy
 */
export class TimeExitStrategy extends BaseExitStrategy {
  get type(): ExitStrategyConfig['type'] {
    return 'time';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as { timeMinutes: number };
    const holdingTimeMinutes = position.getHoldingTimeMinutes();

    if (holdingTimeMinutes >= params.timeMinutes) {
      return {
        shouldExit: true,
        reason: `Time limit reached: ${holdingTimeMinutes.toFixed(1)}min >= ${params.timeMinutes}min`,
        urgency: 'MEDIUM',
        expectedPrice: currentPrice.price,
      };
    }

    return {
      shouldExit: false,
      reason: `Time remaining: ${(params.timeMinutes - holdingTimeMinutes).toFixed(1)}min`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as { timeMinutes: number };
    return `Exit after ${params.timeMinutes} minutes`;
  }
}

/**
 * Profit-based exit strategy
 */
export class ProfitExitStrategy extends BaseExitStrategy {
  get type(): ExitStrategyConfig['type'] {
    return 'profit';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as { profitPercentage: number; trailingStopPercent?: number };
    const { pnlPercent } = position.calculatePnl(currentPrice.price);

    // Use a small epsilon to handle floating point precision issues
    const epsilon = 0.001; // 0.001%
    if (pnlPercent >= params.profitPercentage - epsilon) {
      return {
        shouldExit: true,
        reason: `Profit target reached: ${pnlPercent.toFixed(2)}% >= ${params.profitPercentage}%`,
        urgency: 'HIGH',
        expectedPrice: currentPrice.price,
      };
    }

    return {
      shouldExit: false,
      reason: `Profit needed: ${(params.profitPercentage - pnlPercent).toFixed(2)}%`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as { profitPercentage: number };
    return `Exit at ${params.profitPercentage}% profit`;
  }
}

/**
 * Loss-based exit strategy (stop loss)
 */
export class LossExitStrategy extends BaseExitStrategy {
  get type(): ExitStrategyConfig['type'] {
    return 'loss';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as { lossPercentage: number };
    const { pnlPercent } = position.calculatePnl(currentPrice.price);
    const stopLossThreshold = -Math.abs(params.lossPercentage);

    // Use a small epsilon to handle floating point precision issues
    const epsilon = 0.001; // 0.001%
    if (pnlPercent <= stopLossThreshold + epsilon) {
      return {
        shouldExit: true,
        reason: `Stop loss triggered: ${pnlPercent.toFixed(2)}% <= ${stopLossThreshold}%`,
        urgency: 'HIGH',
        expectedPrice: currentPrice.price,
      };
    }

    return {
      shouldExit: false,
      reason: `Loss buffer: ${Math.abs(pnlPercent - stopLossThreshold).toFixed(2)}%`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as { lossPercentage: number };
    return `Stop loss at ${params.lossPercentage}%`;
  }
}

/**
 * Liquidity-based exit strategy
 */
export class LiquidityExitStrategy extends BaseExitStrategy {
  get type(): ExitStrategyConfig['type'] {
    return 'liquidity';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    // For now, this is a placeholder implementation
    // In a full implementation, we would need access to current liquidity data
    const params = this.config.params as { minLiquidityUsd: number; percentOfInitial?: number };

    // This would need to be implemented with actual liquidity checking
    return {
      shouldExit: false,
      reason: `Liquidity monitoring not yet implemented`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as { minLiquidityUsd: number };
    return `Exit if liquidity falls below ${params.minLiquidityUsd} USD`;
  }
}

/**
 * Developer activity exit strategy
 */
export class DeveloperActivityExitStrategy extends BaseExitStrategy {
  get type(): ExitStrategyConfig['type'] {
    return 'developer-activity';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    // For now, this is a placeholder implementation
    // In a full implementation, we would need access to developer wallet monitoring
    const params = this.config.params as {
      monitorDeveloperWallet: boolean;
      exitOnSellPercentage?: number;
    };

    // This would need to be implemented with actual developer monitoring
    return {
      shouldExit: false,
      reason: `Developer activity monitoring not yet implemented`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    return `Exit on developer activity`;
  }
}

/**
 * Position manager statistics
 */
export interface PositionManagerStats {
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  successRate: number;
  averageHoldingTimeMinutes: number;
  strategiesUsed: Record<string, number>;
}

/**
 * Position manager configuration options
 */
export interface PositionManagerOptions {
  monitoringIntervalMs?: number;
  enableAutomaticExit?: boolean;
  priceUpdateTimeoutMs?: number;
  maxConcurrentExits?: number;
}

/**
 * Main PositionManager class
 */
export class PositionManager implements AdvancedStrategyDataProvider {
  private logger: Logger;
  private db: DatabaseManager;
  private eventManager: EventProcessor;
  private strategies: Map<
    ExitStrategyConfig['type'],
    new (config: ExitStrategyConfig, dataProvider?: AdvancedStrategyDataProvider) => ExitStrategy
  > = new Map();
  private monitoringTimer?: NodeJS.Timeout;
  private options: Required<PositionManagerOptions>;
  private currentPrices: Map<string, TokenPrice> = new Map();
  private pendingExits: Set<string> = new Set();
  private trailingStopData: Map<string, { highestPrice: number; lastStopPrice: number }> =
    new Map();

  constructor(
    db: DatabaseManager,
    eventManager: EventProcessor,
    options: PositionManagerOptions = {},
  ) {
    this.db = db;
    this.eventManager = eventManager;
    this.logger = new Logger('PositionManager');

    this.options = {
      monitoringIntervalMs: options.monitoringIntervalMs || 30000, // 30 seconds
      enableAutomaticExit: options.enableAutomaticExit ?? true,
      priceUpdateTimeoutMs: options.priceUpdateTimeoutMs || 60000, // 1 minute
      maxConcurrentExits: options.maxConcurrentExits || 5,
      ...options,
    };

    this.setupStrategies();
    this.setupEventListeners();
  }

  /**
   * Initialize the position manager
   */
  public async initialize(): Promise<void> {
    this.logger.info('Initializing PositionManager');

    if (this.options.enableAutomaticExit) {
      this.startMonitoring();
    }

    this.logger.info('PositionManager initialized successfully');
  }

  /**
   * Setup exit strategy implementations
   */
  private setupStrategies(): void {
    this.strategies.set('time', TimeExitStrategy);
    this.strategies.set('profit', ProfitExitStrategy);
    this.strategies.set('loss', LossExitStrategy);
    this.strategies.set('liquidity', LiquidityExitStrategy);
    this.strategies.set('developer-activity', DeveloperActivityExitStrategy);

    // Advanced strategies
    this.strategies.set('multi-condition', MultiConditionExitStrategy);
    this.strategies.set('trailing-stop', TrailingStopLossExitStrategy);
    this.strategies.set('volatility-stop', VolatilityBasedStopExitStrategy);
    this.strategies.set('volume-based', VolumeBasedExitStrategy);
    this.strategies.set('sentiment-analysis', SentimentAnalysisExitStrategy);
    this.strategies.set('creator-monitoring', CreatorMonitoringExitStrategy);
    this.strategies.set('partial-exit', PartialExitStrategy);
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for trade results to create positions
    this.eventManager.on('tradeResult', async (tradeResult: TradeResult) => {
      if (tradeResult.success && tradeResult.positionId) {
        this.logger.debug(`Position created: ${tradeResult.positionId}`);
      }
    });

    // Listen for system shutdown
    this.eventManager.on('systemStatus', statusEvent => {
      if (statusEvent.status === 'SHUTDOWN') {
        this.stopMonitoring();
      }
    });
  }

  /**
   * Create a new position
   */
  public async createPosition(
    tokenAddress: string,
    entryPrice: number,
    amount: number,
    entryTradeId: string,
    exitStrategy: ExitStrategyConfig,
  ): Promise<PositionModel> {
    this.logger.info(`Creating position for token ${tokenAddress}`);

    const position = PositionModel.create(
      tokenAddress,
      entryPrice,
      amount,
      entryTradeId,
      exitStrategy,
    );

    await this.db.addPosition(position);

    // Emit position update event
    this.eventManager.emit('positionUpdate', {
      position,
      updateType: 'CREATED',
      reason: 'New position created',
      timestamp: Date.now(),
    });

    this.logger.info(`Position created: ${position.id}`);
    return position;
  }

  /**
   * Get all open positions
   */
  public async getOpenPositions(): Promise<PositionModel[]> {
    const positions = await this.db.getOpenPositions();
    return positions.map(p => new PositionModel(p));
  }

  /**
   * Get position by ID
   */
  public async getPosition(id: string): Promise<PositionModel | null> {
    const position = await this.db.getPosition(id);
    return position ? new PositionModel(position) : null;
  }

  /**
   * Update current price for a token
   */
  public updateTokenPrice(tokenPrice: TokenPrice): void {
    this.currentPrices.set(tokenPrice.tokenAddress, tokenPrice);
    this.logger.debug(`Price updated for ${tokenPrice.tokenAddress}: $${tokenPrice.price}`);
  }

  /**
   * Evaluate exit conditions for a position
   */
  public evaluateExitConditions(
    position: PositionModel,
    currentPrice: TokenPrice,
  ): ExitEvaluationResult {
    const StrategyClass = this.strategies.get(position.exitStrategy.type);
    if (!StrategyClass) {
      return {
        shouldExit: false,
        reason: `Unknown exit strategy: ${position.exitStrategy.type}`,
        urgency: 'LOW',
      };
    }

    // Check if strategy needs data provider (advanced strategies)
    const needsDataProvider = [
      'multi-condition',
      'trailing-stop',
      'volatility-stop',
      'volume-based',
      'sentiment-analysis',
      'creator-monitoring',
    ].includes(position.exitStrategy.type);

    const strategy = needsDataProvider
      ? new StrategyClass(position.exitStrategy, this)
      : new StrategyClass(position.exitStrategy);

    return strategy.evaluate(position, currentPrice);
  }

  /**
   * Process exit request for a position
   */
  public async processExitRequest(exitRequest: PositionExitRequest): Promise<boolean> {
    if (this.pendingExits.has(exitRequest.positionId)) {
      this.logger.warning(`Exit already pending for position ${exitRequest.positionId}`);
      return false;
    }

    const position = await this.getPosition(exitRequest.positionId);
    if (!position || position.status !== 'OPEN') {
      this.logger.warning(`Position ${exitRequest.positionId} not found or already closed`);
      return false;
    }

    this.pendingExits.add(exitRequest.positionId);
    this.logger.info(
      `Processing exit request for position ${exitRequest.positionId}: ${exitRequest.reason}`,
    );

    try {
      // Here we would integrate with the TradeExecutor to execute the exit trade
      // For now, we'll emit an event that the TradeExecutor can listen to
      this.eventManager.emit('tradeDecision', {
        shouldTrade: true,
        targetToken: position.tokenAddress,
        baseToken: 'USDC', // This should be configurable
        poolAddress: '', // Would need to be determined
        tradeAmountUsd: position.amount * (exitRequest.targetPrice || 0),
        expectedAmountOut: position.amount,
        price: exitRequest.targetPrice,
        reason: `Position exit: ${exitRequest.reason}`,
        riskScore: 0, // Exit trades have no risk
      });

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to process exit request: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.pendingExits.delete(exitRequest.positionId);
      return false;
    }
  }

  /**
   * Close a position manually
   */
  public async closePosition(
    positionId: string,
    exitTradeId: string,
    exitPrice: number,
    reason: string = 'Manual close',
  ): Promise<boolean> {
    const position = await this.getPosition(positionId);
    if (!position || position.status !== 'OPEN') {
      this.logger.warning(`Position ${positionId} not found or already closed`);
      return false;
    }

    const closeTimestamp = Date.now();
    const { pnlUsd, pnlPercent } = position.calculatePnl(exitPrice);

    const success = await this.db.closePosition(
      positionId,
      exitTradeId,
      closeTimestamp,
      pnlUsd,
      pnlPercent,
    );

    if (success) {
      position.close(exitTradeId, exitPrice);
      this.pendingExits.delete(positionId);

      // Emit position update event
      this.eventManager.emit('positionUpdate', {
        position,
        previousStatus: 'OPEN',
        updateType: 'CLOSED',
        reason,
        timestamp: closeTimestamp,
      });

      this.logger.info(
        `Position ${positionId} closed with P&L: ${pnlPercent.toFixed(2)}% (${pnlUsd.toFixed(2)} USD)`,
      );
    }

    return success;
  }

  /**
   * Monitor all open positions for exit conditions
   */
  private async monitorPositions(): Promise<void> {
    try {
      const openPositions = await this.getOpenPositions();

      if (openPositions.length === 0) {
        return;
      }

      this.logger.debug(`Monitoring ${openPositions.length} open positions`);

      for (const position of openPositions) {
        if (this.pendingExits.has(position.id)) {
          continue; // Skip positions with pending exits
        }

        const currentPrice = this.currentPrices.get(position.tokenAddress);
        if (!currentPrice) {
          this.logger.debug(`No current price available for ${position.tokenAddress}`);
          continue;
        }

        // Check if price is stale
        const priceAge = Date.now() - currentPrice.timestamp;
        if (priceAge > this.options.priceUpdateTimeoutMs) {
          this.logger.warning(`Stale price for ${position.tokenAddress}: ${priceAge}ms old`);
          continue;
        }

        const evaluation = this.evaluateExitConditions(position, currentPrice);

        if (evaluation.shouldExit && this.options.enableAutomaticExit) {
          if (this.pendingExits.size >= this.options.maxConcurrentExits) {
            this.logger.warning(
              `Maximum concurrent exits reached (${this.options.maxConcurrentExits})`,
            );
            continue;
          }

          await this.processExitRequest({
            positionId: position.id,
            reason: evaluation.reason,
            targetPrice: evaluation.expectedPrice,
            partialExitPercentage: evaluation.partialExitPercentage,
            urgency: evaluation.urgency,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `Error monitoring positions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Start position monitoring
   */
  private startMonitoring(): void {
    if (this.monitoringTimer) {
      this.stopMonitoring();
    }

    this.logger.info(
      `Starting position monitoring with ${this.options.monitoringIntervalMs}ms interval`,
    );

    this.monitoringTimer = setInterval(
      () => this.monitorPositions(),
      this.options.monitoringIntervalMs,
    );
  }

  /**
   * Stop position monitoring
   */
  private stopMonitoring(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
      this.logger.info('Position monitoring stopped');
    }
  }

  /**
   * Get position manager statistics
   */
  public async getStats(): Promise<PositionManagerStats> {
    const [openPositions, closedPositions] = await Promise.all([
      this.db.getOpenPositions(),
      this.db.getClosedPositions(),
    ]);

    const allPositions = [...openPositions, ...closedPositions];
    const totalPositions = allPositions.length;

    let totalPnlUsd = 0;
    let totalPnlPercent = 0;
    let totalHoldingTime = 0;
    let successfulTrades = 0;
    const strategiesUsed: Record<string, number> = {};

    for (const position of allPositions) {
      if (position.pnlUsd !== undefined && position.pnlUsd !== null) {
        totalPnlUsd += position.pnlUsd;
      }
      if (position.pnlPercent !== undefined && position.pnlPercent !== null) {
        totalPnlPercent += position.pnlPercent;
        if (position.pnlPercent > 0) {
          successfulTrades++;
        }
      }

      const holdingTime = new PositionModel(position).getHoldingTimeMinutes();
      totalHoldingTime += holdingTime;

      const strategyType = position.exitStrategy.type;
      strategiesUsed[strategyType] = (strategiesUsed[strategyType] || 0) + 1;
    }

    return {
      totalPositions,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      totalPnlUsd,
      totalPnlPercent: totalPositions > 0 ? totalPnlPercent / totalPositions : 0,
      successRate:
        closedPositions.length > 0 ? (successfulTrades / closedPositions.length) * 100 : 0,
      averageHoldingTimeMinutes: totalPositions > 0 ? totalHoldingTime / totalPositions : 0,
      strategiesUsed,
    };
  }

  /**
   * Shutdown the position manager
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down PositionManager');
    this.stopMonitoring();

    // Wait for any pending exits to complete (with timeout)
    const maxWaitTime = 30000; // 30 seconds
    const checkInterval = 1000; // 1 second
    let waitTime = 0;

    while (this.pendingExits.size > 0 && waitTime < maxWaitTime) {
      this.logger.info(`Waiting for ${this.pendingExits.size} pending exits to complete...`);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitTime += checkInterval;
    }

    if (this.pendingExits.size > 0) {
      this.logger.warning(
        `Shutting down with ${this.pendingExits.size} pending exits still in progress`,
      );
    }

    this.logger.info('PositionManager shutdown complete');
  }

  // AdvancedStrategyDataProvider implementation
  async getPriceHistory(
    tokenAddress: string,
    minutes: number,
  ): Promise<import('../types').PricePoint[]> {
    // This is a placeholder implementation
    // In production, this would fetch price history from the database or external API
    const currentPrice = this.currentPrices.get(tokenAddress);
    if (!currentPrice) {
      return [];
    }

    // Generate mock price history for now
    const priceHistory: import('../types').PricePoint[] = [];
    const basePrice = currentPrice.price;
    const intervals = Math.min(minutes, 60); // Max 60 data points

    for (let i = intervals; i >= 0; i--) {
      const timestamp = Date.now() - i * 60 * 1000;
      const volatility = Math.random() * 0.1 - 0.05; // ±5% random volatility
      const price = basePrice * (1 + volatility);

      priceHistory.push({
        price,
        timestamp,
        source: 'mock',
      });
    }

    return priceHistory;
  }

  async getVolumeHistory(
    tokenAddress: string,
    minutes: number,
  ): Promise<import('../types').VolumeData[]> {
    // Placeholder implementation
    // In production, this would fetch volume data from the database or external API
    const volumeHistory: import('../types').VolumeData[] = [];
    const baseVolume = 10000; // Mock base volume

    for (let i = minutes; i >= 0; i--) {
      const timestamp = Date.now() - i * 60 * 1000;
      const volumeMultiplier = Math.random() * 2 + 0.5; // 0.5x to 2.5x variation
      const volumeUsd = baseVolume * volumeMultiplier;

      volumeHistory.push({
        volumeUsd,
        timestamp,
        source: 'mock',
      });
    }

    return volumeHistory;
  }

  async getSentimentData(tokenAddress: string): Promise<import('../types').SentimentData[]> {
    // Placeholder implementation
    // In production, this would fetch sentiment data from external APIs
    return [
      {
        score: Math.random() * 200 - 100, // -100 to 100
        confidence: Math.random() * 100,
        sources: ['social', 'technical'],
        timestamp: Date.now(),
      },
    ];
  }

  async getCreatorActivity(
    tokenAddress: string,
    minutes: number,
  ): Promise<import('../types').CreatorActivity[]> {
    // Placeholder implementation
    // In production, this would monitor creator wallet transactions
    return [];
  }

  async getTrailingStopData(
    positionId: string,
  ): Promise<{ highestPrice: number; lastStopPrice: number } | null> {
    return this.trailingStopData.get(positionId) || null;
  }

  async updateTrailingStopData(
    positionId: string,
    highestPrice: number,
    stopPrice: number,
  ): Promise<void> {
    this.trailingStopData.set(positionId, { highestPrice, lastStopPrice: stopPrice });
  }
}
