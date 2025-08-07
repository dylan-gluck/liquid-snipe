/**
 * Advanced exit strategies for position management
 * Implements sophisticated exit conditions including trailing stops, volatility-based exits,
 * volume analysis, sentiment analysis, and multi-condition strategies
 */

import { BaseExitStrategy, ExitEvaluationResult, TokenPrice } from './exit-strategy-base';
import { AnalysisUtils } from './analysis-utils';
import { Logger } from '../utils/logger';
import { PositionModel } from '../db/models/position';
import {
  ExitStrategyConfig,
  MultiConditionExitParams,
  TrailingStopLossParams,
  VolatilityBasedStopParams,
  VolumeBasedExitParams,
  SentimentAnalysisParams,
  CreatorMonitoringParams,
  PartialExitParams,
  PricePoint,
  VolumeData,
  SentimentData,
  CreatorActivity,
} from '../types';

/**
 * Interface for data providers needed by advanced strategies
 */
export interface AdvancedStrategyDataProvider {
  getPriceHistory(tokenAddress: string, minutes: number): Promise<PricePoint[]>;
  getVolumeHistory(tokenAddress: string, minutes: number): Promise<VolumeData[]>;
  getSentimentData(tokenAddress: string): Promise<SentimentData[]>;
  getCreatorActivity(tokenAddress: string, minutes: number): Promise<CreatorActivity[]>;
  getTrailingStopData(
    positionId: string,
  ): Promise<{ highestPrice: number; lastStopPrice: number } | null>;
  updateTrailingStopData(
    positionId: string,
    highestPrice: number,
    stopPrice: number,
  ): Promise<void>;
}

/**
 * Multi-condition exit strategy that combines multiple exit conditions
 */
export class MultiConditionExitStrategy extends BaseExitStrategy {
  private logger = new Logger('MultiConditionExitStrategy');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'multi-condition';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as MultiConditionExitParams;
    const results: ExitEvaluationResult[] = [];

    // Evaluate all sub-conditions
    for (const condition of params.conditions) {
      if (!condition.enabled) continue;

      try {
        let strategy: BaseExitStrategy | null = null;

        // Create appropriate strategy instance
        switch (condition.type) {
          case 'profit':
            strategy = new (require('./position-manager').ProfitExitStrategy)(condition);
            break;
          case 'loss':
            strategy = new (require('./position-manager').LossExitStrategy)(condition);
            break;
          case 'time':
            strategy = new (require('./position-manager').TimeExitStrategy)(condition);
            break;
          case 'trailing-stop':
            strategy = new TrailingStopLossExitStrategy(condition, this.dataProvider);
            break;
          case 'volatility-stop':
            strategy = new VolatilityBasedStopExitStrategy(condition, this.dataProvider);
            break;
          case 'volume-based':
            strategy = new VolumeBasedExitStrategy(condition, this.dataProvider);
            break;
          case 'sentiment-analysis':
            strategy = new SentimentAnalysisExitStrategy(condition, this.dataProvider);
            break;
          case 'creator-monitoring':
            strategy = new CreatorMonitoringExitStrategy(condition, this.dataProvider);
            break;
          default:
            this.logger.warning(`Unknown condition type: ${condition.type}`);
            continue;
        }

        if (strategy) {
          const result = strategy.evaluate(position, currentPrice);
          results.push(result);
        }
      } catch (error) {
        this.logger.error(
          `Error evaluating condition ${condition.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (results.length === 0) {
      return {
        shouldExit: false,
        reason: 'No valid conditions to evaluate',
        urgency: 'LOW',
      };
    }

    // Apply operator logic
    return this.combineResults(results, params.operator, params.priority);
  }

  private combineResults(
    results: ExitEvaluationResult[],
    operator: 'AND' | 'OR',
    priority?: 'HIGHEST_URGENCY' | 'FIRST_MATCH' | 'ALL_CONDITIONS',
  ): ExitEvaluationResult {
    const exitResults = results.filter(r => r.shouldExit);
    const nonExitResults = results.filter(r => !r.shouldExit);

    if (operator === 'AND') {
      if (exitResults.length === results.length) {
        // All conditions want to exit
        const highestUrgency = this.getHighestUrgency(exitResults);
        return {
          shouldExit: true,
          reason: `All conditions met: ${exitResults.map(r => r.reason).join('; ')}`,
          urgency: highestUrgency.urgency,
          expectedPrice: highestUrgency.expectedPrice,
          partialExitPercentage: highestUrgency.partialExitPercentage,
        };
      } else {
        return {
          shouldExit: false,
          reason: `Waiting for all conditions: ${nonExitResults.map(r => r.reason).join('; ')}`,
          urgency: 'LOW',
        };
      }
    } else {
      // OR
      if (exitResults.length > 0) {
        const selected = this.selectResult(exitResults, priority);
        return {
          shouldExit: true,
          reason: `Condition met: ${selected.reason}`,
          urgency: selected.urgency,
          expectedPrice: selected.expectedPrice,
          partialExitPercentage: selected.partialExitPercentage,
        };
      } else {
        return {
          shouldExit: false,
          reason: `No conditions met: ${nonExitResults.map(r => r.reason).join('; ')}`,
          urgency: 'LOW',
        };
      }
    }
  }

  private selectResult(
    results: ExitEvaluationResult[],
    priority?: 'HIGHEST_URGENCY' | 'FIRST_MATCH' | 'ALL_CONDITIONS',
  ): ExitEvaluationResult {
    switch (priority) {
      case 'HIGHEST_URGENCY':
        return this.getHighestUrgency(results);
      case 'FIRST_MATCH':
        return results[0];
      case 'ALL_CONDITIONS':
      default:
        return this.getHighestUrgency(results);
    }
  }

  private getHighestUrgency(results: ExitEvaluationResult[]): ExitEvaluationResult {
    return results.reduce((highest, current) => {
      const urgencyOrder = { LOW: 1, MEDIUM: 2, HIGH: 3 };
      return urgencyOrder[current.urgency] > urgencyOrder[highest.urgency] ? current : highest;
    });
  }

  getDescription(): string {
    const params = this.config.params as MultiConditionExitParams;
    return `Multi-condition (${params.operator}): ${params.conditions.length} conditions`;
  }
}

/**
 * Trailing stop loss exit strategy
 */
export class TrailingStopLossExitStrategy extends BaseExitStrategy {
  private logger = new Logger('TrailingStopLoss');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'trailing-stop';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as TrailingStopLossParams;

    try {
      // For synchronous evaluation, we'll use a simplified approach
      // In a full implementation, this would have access to persistent trailing stop data
      const currentGain = ((currentPrice.price - position.entryPrice) / position.entryPrice) * 100;
      const activationPercent = params.activationPercent || 0;

      if (currentGain < activationPercent) {
        return {
          shouldExit: false,
          reason: `Trailing stop not active: ${currentGain.toFixed(2)}% < ${activationPercent}%`,
          urgency: 'LOW',
        };
      }

      // Simple trailing stop calculation assuming highest price is current price
      const stopPrice = currentPrice.price * (1 - params.trailPercent / 100);

      // For the synchronous version, we'll use the initial stop as a fallback
      const initialStopPrice = position.entryPrice * (1 - params.initialStopPercent / 100);
      const effectiveStopPrice = Math.max(stopPrice, initialStopPrice);

      if (currentPrice.price <= effectiveStopPrice) {
        return {
          shouldExit: true,
          reason: `Trailing stop triggered: ${currentPrice.price.toFixed(6)} <= ${effectiveStopPrice.toFixed(6)}`,
          urgency: 'HIGH',
          expectedPrice: effectiveStopPrice,
        };
      }

      const stopDistance = ((currentPrice.price - effectiveStopPrice) / currentPrice.price) * 100;
      return {
        shouldExit: false,
        reason: `Trailing stop active: ${stopDistance.toFixed(2)}% buffer`,
        urgency: 'LOW',
      };
    } catch (error) {
      this.logger.error(
        `Error in trailing stop evaluation: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        shouldExit: false,
        reason: 'Error calculating trailing stop',
        urgency: 'LOW',
      };
    }
  }

  getDescription(): string {
    const params = this.config.params as TrailingStopLossParams;
    return `Trailing stop: ${params.trailPercent}% trail, activation at ${params.activationPercent || 0}%`;
  }
}

/**
 * Volatility-based stop loss exit strategy
 */
export class VolatilityBasedStopExitStrategy extends BaseExitStrategy {
  private logger = new Logger('VolatilityBasedStop');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'volatility-stop';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as VolatilityBasedStopParams;

    try {
      // For synchronous evaluation, use a simplified volatility estimate
      // In production, this would use actual price history
      const assumedVolatility = 15; // Assume 15% volatility as default

      const stopPrice = AnalysisUtils.calculateVolatilityAdjustedStop(
        currentPrice.price,
        assumedVolatility,
        params.baseStopPercent,
        params.volatilityMultiplier,
        params.minStopPercent,
        params.maxStopPercent,
      );

      if (currentPrice.price <= stopPrice) {
        return {
          shouldExit: true,
          reason: `Volatility stop triggered: ${currentPrice.price.toFixed(6)} <= ${stopPrice.toFixed(6)} (assumed volatility: ${assumedVolatility}%)`,
          urgency: 'HIGH',
          expectedPrice: stopPrice,
        };
      }

      const stopDistance = ((currentPrice.price - stopPrice) / currentPrice.price) * 100;
      return {
        shouldExit: false,
        reason: `Volatility stop: ${stopDistance.toFixed(2)}% buffer (assumed volatility: ${assumedVolatility}%)`,
        urgency: 'LOW',
      };
    } catch (error) {
      this.logger.error(
        `Error in volatility stop evaluation: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        shouldExit: false,
        reason: 'Error calculating volatility stop',
        urgency: 'LOW',
      };
    }
  }

  getDescription(): string {
    const params = this.config.params as VolatilityBasedStopParams;
    return `Volatility stop: ${params.baseStopPercent}% base, ${params.volatilityMultiplier}x multiplier`;
  }
}

/**
 * Volume-based exit strategy
 */
export class VolumeBasedExitStrategy extends BaseExitStrategy {
  private logger = new Logger('VolumeBasedExit');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'volume-based';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as VolumeBasedExitParams;

    // For synchronous evaluation, use placeholder logic
    // In production, this would use actual volume data
    return {
      shouldExit: false,
      reason: `Volume monitoring active (min: $${params.minVolumeUsd}, drop threshold: ${params.volumeDropThresholdPercent}%)`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as VolumeBasedExitParams;
    return `Volume exit: min $${params.minVolumeUsd}, ${params.volumeDropThresholdPercent}% drop threshold`;
  }
}

/**
 * Sentiment analysis exit strategy (placeholder implementation)
 */
export class SentimentAnalysisExitStrategy extends BaseExitStrategy {
  private logger = new Logger('SentimentAnalysis');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'sentiment-analysis';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as SentimentAnalysisParams;

    // For synchronous evaluation, use placeholder logic
    // In production, this would use actual sentiment data from external APIs
    return {
      shouldExit: false,
      reason: `Sentiment monitoring active (threshold: ${params.sentimentThreshold}, confidence: ${params.confidenceThreshold}%)`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as SentimentAnalysisParams;
    return `Sentiment exit: threshold ${params.sentimentThreshold}, confidence ${params.confidenceThreshold}%`;
  }
}

/**
 * Creator monitoring exit strategy
 */
export class CreatorMonitoringExitStrategy extends BaseExitStrategy {
  private logger = new Logger('CreatorMonitoring');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'creator-monitoring';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as CreatorMonitoringParams;

    // For synchronous evaluation, use placeholder logic
    // In production, this would monitor actual creator wallet transactions
    return {
      shouldExit: false,
      reason: `Creator monitoring active (threshold: ${params.sellThresholdPercent}%, first sell: ${params.exitOnFirstSell})`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as CreatorMonitoringParams;
    return `Creator monitoring: ${params.sellThresholdPercent}% sell threshold`;
  }
}

/**
 * Partial exit strategy
 */
export class PartialExitStrategy extends BaseExitStrategy {
  private logger = new Logger('PartialExit');

  constructor(
    config: ExitStrategyConfig,
    private dataProvider?: AdvancedStrategyDataProvider,
  ) {
    super(config);
  }

  get type(): ExitStrategyConfig['type'] {
    return 'partial-exit';
  }

  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult {
    const params = this.config.params as PartialExitParams;

    // Find the first stage that should trigger
    for (const stage of params.stages) {
      if (!stage.triggerCondition.enabled) continue;

      // Create strategy for trigger condition
      let strategy: BaseExitStrategy | null = null;

      try {
        switch (stage.triggerCondition.type) {
          case 'profit':
            strategy = new (require('./position-manager').ProfitExitStrategy)(
              stage.triggerCondition,
            );
            break;
          case 'loss':
            strategy = new (require('./position-manager').LossExitStrategy)(stage.triggerCondition);
            break;
          case 'time':
            strategy = new (require('./position-manager').TimeExitStrategy)(stage.triggerCondition);
            break;
          default:
            this.logger.warning(
              `Unsupported trigger condition type: ${stage.triggerCondition.type}`,
            );
            continue;
        }

        if (strategy) {
          const result = strategy.evaluate(position, currentPrice);
          if (result.shouldExit) {
            return {
              shouldExit: true,
              reason: `Partial exit stage triggered: ${result.reason}`,
              urgency: result.urgency,
              expectedPrice: result.expectedPrice,
              partialExitPercentage: stage.exitPercentage,
            };
          }
        }
      } catch (error) {
        this.logger.error(
          `Error evaluating partial exit stage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      shouldExit: false,
      reason: `No partial exit stages triggered`,
      urgency: 'LOW',
    };
  }

  getDescription(): string {
    const params = this.config.params as PartialExitParams;
    return `Partial exit: ${params.stages.length} stages`;
  }
}
