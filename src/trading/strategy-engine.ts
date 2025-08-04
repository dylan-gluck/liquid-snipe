import { ConnectionManager } from '../blockchain/connection-manager';
import { TokenInfoService, TokenInfo } from '../blockchain/token-info-service';
import { DatabaseManager } from '../db';
import { Logger } from '../utils/logger';
import { NewPoolEvent, TradeDecision, TradeConfig, WalletConfig, AppConfig } from '../types';

/**
 * Represents a trading strategy interface
 */
export interface TradeStrategy {
  readonly name: string;
  readonly description: string;
  readonly priority: number; // Lower number = higher priority

  /**
   * Evaluate whether this strategy should recommend a trade
   */
  evaluate(context: StrategyContext): Promise<StrategyResult>;
}

/**
 * Context provided to strategies for evaluation
 */
export interface StrategyContext {
  poolEvent: NewPoolEvent;
  tokenAInfo: TokenInfo;
  tokenBInfo: TokenInfo;
  newToken: TokenInfo;
  baseToken: TokenInfo;
  poolLiquidity: number;
  currentPrice?: number;
  config: TradeConfig;
  walletConfig: WalletConfig;
}

/**
 * Result returned by a strategy evaluation
 */
export interface StrategyResult {
  shouldTrade: boolean;
  confidence: number; // 0-1 scale
  recommendedAmount?: number; // USD
  maxRisk?: number; // 0-1 scale
  reason: string;
  metadata?: Record<string, any>;
}

/**
 * Pool liquidity information
 */
export interface PoolLiquidityInfo {
  totalLiquidityUsd: number;
  tokenAReserve: number;
  tokenBReserve: number;
  priceRatio: number;
  volume24h?: number;
}

/**
 * Abstract base class for trading strategies
 */
export abstract class BaseStrategy implements TradeStrategy {
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly priority: number;

  protected logger: Logger;

  constructor() {
    this.logger = new Logger('Strategy');
  }

  public abstract evaluate(context: StrategyContext): Promise<StrategyResult>;

  /**
   * Helper method to calculate position size based on risk parameters
   */
  protected calculatePositionSize(
    availableCapital: number,
    riskPercentage: number,
    riskScore: number,
  ): number {
    // Reduce position size based on risk score (0-10 scale)
    const riskMultiplier = Math.max(0.1, 1 - (riskScore / 10) * 0.5);
    return availableCapital * (riskPercentage / 100) * riskMultiplier;
  }

  /**
   * Helper method to check if token meets basic criteria
   */
  protected isTokenEligible(tokenInfo: TokenInfo, config: TradeConfig): boolean {
    // Check if token has required metadata
    if (!tokenInfo.symbol || !tokenInfo.decimals) {
      return false;
    }

    // Check supply constraints
    if (config.maxTokenSupply && tokenInfo.supply && tokenInfo.supply > config.maxTokenSupply) {
      return false;
    }

    // Check minimum price if available
    if (config.minTokenPrice && tokenInfo.metadata.currentPrice) {
      if (tokenInfo.metadata.currentPrice < config.minTokenPrice) {
        return false;
      }
    }

    // Check if token is too risky
    if (tokenInfo.riskScore > 8) {
      return false;
    }

    return true;
  }
}

/**
 * Strategy that filters based on liquidity thresholds and basic token criteria
 */
export class LiquidityThresholdStrategy extends BaseStrategy {
  public readonly name = 'liquidity-threshold';
  public readonly description = 'Filter tokens based on minimum liquidity requirements';
  public readonly priority = 1;

  public async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { poolLiquidity, newToken, config } = context;

    // Check minimum liquidity
    if (poolLiquidity < config.minLiquidityUsd) {
      return {
        shouldTrade: false,
        confidence: 0,
        reason: `Insufficient liquidity: $${poolLiquidity.toFixed(2)} < $${config.minLiquidityUsd}`,
      };
    }

    // Check if token is eligible
    if (!this.isTokenEligible(newToken, config)) {
      return {
        shouldTrade: false,
        confidence: 0,
        reason: 'Token does not meet basic eligibility criteria',
      };
    }

    // Calculate confidence based on liquidity ratio
    const liquidityRatio = poolLiquidity / config.minLiquidityUsd;
    const confidence = Math.min(0.8, Math.log10(liquidityRatio) * 0.3 + 0.5);

    return {
      shouldTrade: true,
      confidence: Math.max(0.1, confidence),
      reason: `Good liquidity: $${poolLiquidity.toFixed(2)}`,
      metadata: {
        liquidityRatio,
        poolLiquidity,
      },
    };
  }
}

/**
 * Strategy that evaluates risk vs reward potential
 */
export class RiskAssessmentStrategy extends BaseStrategy {
  public readonly name = 'risk-assessment';
  public readonly description = 'Evaluate risk vs reward potential of new tokens';
  public readonly priority = 2;

  public async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { newToken, poolLiquidity, walletConfig } = context;

    const riskScore = newToken.riskScore;

    // Reject high-risk tokens
    if (riskScore > 7) {
      return {
        shouldTrade: false,
        confidence: 0,
        reason: `Risk score too high: ${riskScore}/10`,
      };
    }

    // Calculate risk-adjusted confidence
    const riskFactor = (10 - riskScore) / 10; // 0-1 scale, higher is better
    const liquidityFactor = Math.min(1, poolLiquidity / 10000); // Cap at $10k
    const confidence = riskFactor * 0.7 + liquidityFactor * 0.3;

    // Calculate recommended position size
    const availableCapital = 10000; // TODO: Get from wallet balance
    const recommendedAmount = this.calculatePositionSize(
      availableCapital,
      walletConfig.riskPercent,
      riskScore,
    );

    return {
      shouldTrade: confidence > 0.3,
      confidence,
      recommendedAmount,
      maxRisk: riskScore / 10,
      reason: `Risk score: ${riskScore}/10, Confidence: ${(confidence * 100).toFixed(1)}%`,
      metadata: {
        riskScore,
        riskFactor,
        liquidityFactor,
      },
    };
  }
}

/**
 * Main strategy engine that coordinates pool evaluation and trade decisions
 */
export class StrategyEngine {
  private connectionManager: ConnectionManager;
  private tokenInfoService: TokenInfoService;
  private dbManager: DatabaseManager;
  private config: AppConfig;
  private logger: Logger;
  private strategies: TradeStrategy[];

  constructor(
    connectionManager: ConnectionManager,
    tokenInfoService: TokenInfoService,
    dbManager: DatabaseManager,
    config: AppConfig,
  ) {
    this.connectionManager = connectionManager;
    this.tokenInfoService = tokenInfoService;
    this.dbManager = dbManager;
    this.config = config;
    this.logger = new Logger('StrategyEngine');

    // Initialize default strategies
    this.strategies = [new LiquidityThresholdStrategy(), new RiskAssessmentStrategy()];

    // Sort strategies by priority (lower number = higher priority)
    this.strategies.sort((a, b) => a.priority - b.priority);

    this.logger.info(`Initialized with ${this.strategies.length} strategies`);
  }

  /**
   * Add a custom strategy to the engine
   */
  public addStrategy(strategy: TradeStrategy): void {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => a.priority - b.priority);
    this.logger.info(`Added strategy: ${strategy.name}`);
  }

  /**
   * Remove a strategy by name
   */
  public removeStrategy(name: string): boolean {
    const index = this.strategies.findIndex(s => s.name === name);
    if (index !== -1) {
      this.strategies.splice(index, 1);
      this.logger.info(`Removed strategy: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Get list of active strategies
   */
  public getStrategies(): TradeStrategy[] {
    return [...this.strategies];
  }

  /**
   * Main method to evaluate a new pool event and generate trade recommendations
   */
  public async evaluatePool(poolEvent: NewPoolEvent): Promise<TradeDecision | null> {
    try {
      this.logger.debug(`Evaluating pool: ${poolEvent.poolAddress}`);

      // Gather token information
      const [tokenAInfo, tokenBInfo] = await Promise.all([
        this.tokenInfoService.getTokenInfo(poolEvent.tokenA),
        this.tokenInfoService.getTokenInfo(poolEvent.tokenB),
      ]);

      if (!tokenAInfo || !tokenBInfo) {
        this.logger.warning(`Failed to get token info for pool ${poolEvent.poolAddress}`);
        return null;
      }

      // Identify which token is new
      const newToken = this.tokenInfoService.isNewToken(tokenAInfo, tokenBInfo);
      if (!newToken) {
        this.logger.debug(`No new token identified in pool ${poolEvent.poolAddress}`);
        return null;
      }

      const baseToken = newToken === tokenAInfo ? tokenBInfo : tokenAInfo;

      // Get pool liquidity information
      const poolLiquidity = await this.getPoolLiquidity(poolEvent.poolAddress);
      if (poolLiquidity === null) {
        this.logger.warning(`Failed to get liquidity for pool ${poolEvent.poolAddress}`);
        return null;
      }

      // Create strategy context
      const context: StrategyContext = {
        poolEvent,
        tokenAInfo,
        tokenBInfo,
        newToken,
        baseToken,
        poolLiquidity: poolLiquidity.totalLiquidityUsd,
        config: this.config.tradeConfig,
        walletConfig: this.config.wallet,
      };

      // Evaluate with each strategy
      const results: StrategyResult[] = [];
      for (const strategy of this.strategies) {
        try {
          const result = await strategy.evaluate(context);
          results.push(result);

          this.logger.debug(
            `Strategy ${strategy.name}: ${result.shouldTrade ? 'TRADE' : 'SKIP'} (${result.reason})`,
          );

          // If any strategy says no trade, stop evaluation
          if (!result.shouldTrade) {
            return {
              shouldTrade: false,
              targetToken: newToken.address,
              baseToken: baseToken.address,
              poolAddress: poolEvent.poolAddress,
              tradeAmountUsd: 0,
              reason: `${strategy.name}: ${result.reason}`,
              riskScore: newToken.riskScore,
            };
          }
        } catch (error) {
          this.logger.error(`Error in strategy ${strategy.name}:`, {
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue with other strategies
        }
      }

      // If all strategies approved, generate final trade decision
      return this.generateTradeDecision(context, results);
    } catch (error) {
      this.logger.error(`Error evaluating pool ${poolEvent.poolAddress}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get pool liquidity information
   */
  public async getPoolLiquidity(poolAddress: string): Promise<PoolLiquidityInfo | null> {
    try {
      // TODO: Implement actual pool liquidity fetching
      // For now, return mock data
      this.logger.debug(`Getting liquidity for pool ${poolAddress}`);

      // This would normally fetch from the DEX's pool account
      // and calculate USD value based on token prices
      return {
        totalLiquidityUsd: Math.random() * 50000 + 1000, // Mock: $1k-$51k
        tokenAReserve: Math.random() * 1000000,
        tokenBReserve: Math.random() * 1000000,
        priceRatio: Math.random() * 0.01 + 0.0001,
        volume24h: Math.random() * 10000,
      };
    } catch (error) {
      this.logger.error(`Failed to get pool liquidity for ${poolAddress}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Generate final trade decision based on strategy results
   */
  private generateTradeDecision(
    context: StrategyContext,
    results: StrategyResult[],
  ): TradeDecision {
    // Calculate weighted confidence score
    const totalConfidence = results.reduce((sum, result) => sum + result.confidence, 0);
    const avgConfidence = totalConfidence / results.length;

    // Calculate recommended trade amount
    const recommendedAmounts = results
      .filter(r => r.recommendedAmount !== undefined)
      .map(r => r.recommendedAmount!);

    const tradeAmount =
      recommendedAmounts.length > 0
        ? Math.min(...recommendedAmounts) // Use most conservative amount
        : this.config.tradeConfig.defaultTradeAmountUsd;

    // Determine expected outcome
    const expectedAmountOut = this.calculateExpectedAmountOut(
      tradeAmount,
      context.poolLiquidity,
      context.newToken,
    );

    const reason = `All strategies approved (avg confidence: ${(avgConfidence * 100).toFixed(1)}%)`;

    return {
      shouldTrade: true,
      targetToken: context.newToken.address,
      baseToken: context.baseToken.address,
      poolAddress: context.poolEvent.poolAddress,
      tradeAmountUsd: tradeAmount,
      expectedAmountOut,
      price: context.currentPrice,
      reason,
      riskScore: context.newToken.riskScore,
    };
  }

  /**
   * Calculate expected amount out for a trade
   */
  private calculateExpectedAmountOut(
    tradeAmountUsd: number,
    poolLiquidity: number,
    targetToken: TokenInfo,
  ): number {
    // Simple calculation - in practice this would use AMM formulas
    // and account for slippage, fees, etc.
    const mockPrice = 0.0001 + Math.random() * 0.01; // $0.0001 - $0.0101
    return tradeAmountUsd / mockPrice;
  }

  /**
   * Get strategy statistics
   */
  public getStats(): {
    totalStrategies: number;
    strategies: Array<{
      name: string;
      description: string;
      priority: number;
    }>;
  } {
    return {
      totalStrategies: this.strategies.length,
      strategies: this.strategies.map(s => ({
        name: s.name,
        description: s.description,
        priority: s.priority,
      })),
    };
  }
}
