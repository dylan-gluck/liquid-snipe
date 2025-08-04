import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../utils/logger';

/**
 * Represents market volatility metrics
 */
export interface VolatilityMetrics {
  priceVolatility: number; // 0-1 scale
  volumeVolatility: number; // 0-1 scale
  liquidityVolatility: number; // 0-1 scale
  overallVolatility: number; // 0-1 scale
  timeWindow: number; // milliseconds
}

/**
 * Represents market impact estimation
 */
export interface MarketImpactEstimation {
  estimatedImpact: number; // percentage
  confidenceLevel: number; // 0-1 scale
  liquidityDepth: number; // USD value
  orderBookImbalance: number; // -1 to 1 scale
  recommendedMaxTradeSize: number; // USD value
}

/**
 * Represents dynamic slippage calculation result
 */
export interface DynamicSlippageResult {
  recommendedSlippage: number; // percentage
  minimumSlippage: number; // percentage
  maximumSlippage: number; // percentage
  riskAdjustment: number; // percentage adjustment
  volatilityAdjustment: number; // percentage adjustment
  liquidityAdjustment: number; // percentage adjustment
  reasoning: string[];
}

/**
 * Represents adaptive slippage limits
 */
export interface AdaptiveSlippageLimits {
  currentLimit: number; // percentage
  baseLimit: number; // percentage
  adjustedForVolatility: number; // percentage
  adjustedForLiquidity: number; // percentage
  adjustedForSize: number; // percentage
  emergencyLimit: number; // percentage
  shouldUseEmergency: boolean;
}

/**
 * Configuration for slippage protection
 */
export interface SlippageProtectionConfig {
  baseSlippagePercent: number;
  maxSlippagePercent: number;
  volatilityMultiplier: number;
  liquidityThresholdUsd: number;
  marketImpactThreshold: number;
  emergencySlippagePercent: number;
  adaptiveSlippageEnabled: boolean;
  circuitBreakerEnabled: boolean;
}

/**
 * SlippageProtection provides advanced slippage calculation and protection
 * mechanisms including dynamic slippage based on market conditions,
 * volatility analysis, and emergency circuit breakers.
 */
export class SlippageProtection {
  private connection: Connection;
  private logger: Logger;
  private config: SlippageProtectionConfig;
  private volatilityCache: Map<string, VolatilityMetrics>;
  private liquidityCache: Map<string, number>;
  private priceHistory: Map<string, Array<{ price: number; timestamp: number }>>;
  private circuitBreakerTripped: boolean;

  constructor(connection: Connection, config: SlippageProtectionConfig) {
    this.connection = connection;
    this.logger = new Logger('SlippageProtection');
    this.config = config;
    this.volatilityCache = new Map();
    this.liquidityCache = new Map();
    this.priceHistory = new Map();
    this.circuitBreakerTripped = false;

    // Start background tasks
    this.startVolatilityMonitoring();
    this.startLiquidityMonitoring();
  }

  /**
   * Calculate dynamic slippage based on current market conditions
   */
  public async calculateDynamicSlippage(
    tokenAddress: string,
    poolAddress: string,
    tradeAmountUsd: number
  ): Promise<DynamicSlippageResult> {
    try {
      this.logger.debug('Calculating dynamic slippage', {
        tokenAddress,
        poolAddress,
        tradeAmountUsd,
      });

      const reasoning: string[] = [];
      let recommendedSlippage = this.config.baseSlippagePercent;

      // Get volatility metrics
      const volatility = await this.getVolatilityMetrics(tokenAddress);
      const volatilityAdjustment = volatility.overallVolatility * this.config.volatilityMultiplier;
      recommendedSlippage += volatilityAdjustment;
      reasoning.push(`Volatility adjustment: +${volatilityAdjustment.toFixed(2)}% (volatility: ${(volatility.overallVolatility * 100).toFixed(1)}%)`);

      // Get market impact estimation
      const marketImpact = await this.estimateMarketImpact(poolAddress, tradeAmountUsd);
      const impactAdjustment = Math.max(0, marketImpact.estimatedImpact - this.config.marketImpactThreshold);
      recommendedSlippage += impactAdjustment;
      reasoning.push(`Market impact adjustment: +${impactAdjustment.toFixed(2)}% (estimated impact: ${marketImpact.estimatedImpact.toFixed(2)}%)`);

      // Liquidity adjustment
      const liquidity = this.liquidityCache.get(poolAddress) || 0;
      let liquidityAdjustment = 0;
      if (liquidity < this.config.liquidityThresholdUsd) {
        liquidityAdjustment = (this.config.liquidityThresholdUsd - liquidity) / this.config.liquidityThresholdUsd * 2;
        recommendedSlippage += liquidityAdjustment;
        reasoning.push(`Low liquidity adjustment: +${liquidityAdjustment.toFixed(2)}% (liquidity: $${liquidity.toFixed(0)})`);
      }

      // Risk adjustment for large trades
      let riskAdjustment = 0;
      if (tradeAmountUsd > marketImpact.recommendedMaxTradeSize) {
        riskAdjustment = (tradeAmountUsd - marketImpact.recommendedMaxTradeSize) / marketImpact.recommendedMaxTradeSize * 1.5;
        recommendedSlippage += riskAdjustment;
        reasoning.push(`Large trade risk adjustment: +${riskAdjustment.toFixed(2)}% (trade exceeds recommended size)`);
      }

      // Apply bounds
      const minimumSlippage = this.config.baseSlippagePercent * 0.5;
      const maximumSlippage = this.config.maxSlippagePercent;
      recommendedSlippage = Math.max(minimumSlippage, Math.min(maximumSlippage, recommendedSlippage));

      if (recommendedSlippage === maximumSlippage) {
        reasoning.push(`Capped at maximum slippage: ${maximumSlippage}%`);
      }

      this.logger.debug('Dynamic slippage calculated', {
        recommendedSlippage,
        volatilityAdjustment,
        impactAdjustment,
        liquidityAdjustment,
        riskAdjustment,
      });

      return {
        recommendedSlippage,
        minimumSlippage,
        maximumSlippage,
        riskAdjustment,
        volatilityAdjustment,
        liquidityAdjustment,
        reasoning,
      };
    } catch (error) {
      this.logger.error('Failed to calculate dynamic slippage:', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative fallback
      return {
        recommendedSlippage: this.config.maxSlippagePercent,
        minimumSlippage: this.config.baseSlippagePercent,
        maximumSlippage: this.config.maxSlippagePercent,
        riskAdjustment: 0,
        volatilityAdjustment: 0,
        liquidityAdjustment: 0,
        reasoning: ['Error calculating dynamic slippage - using maximum conservative value'],
      };
    }
  }

  /**
   * Get adaptive slippage limits based on current conditions
   */
  public async getAdaptiveSlippageLimits(
    tokenAddress: string,
    poolAddress: string,
    tradeAmountUsd: number
  ): Promise<AdaptiveSlippageLimits> {
    if (!this.config.adaptiveSlippageEnabled) {
      return {
        currentLimit: this.config.baseSlippagePercent,
        baseLimit: this.config.baseSlippagePercent,
        adjustedForVolatility: this.config.baseSlippagePercent,
        adjustedForLiquidity: this.config.baseSlippagePercent,
        adjustedForSize: this.config.baseSlippagePercent,
        emergencyLimit: this.config.emergencySlippagePercent,
        shouldUseEmergency: false,
      };
    }

    const dynamicResult = await this.calculateDynamicSlippage(tokenAddress, poolAddress, tradeAmountUsd);
    const volatility = await this.getVolatilityMetrics(tokenAddress);
    const liquidity = this.liquidityCache.get(poolAddress) || 0;

    // Check for emergency conditions
    const shouldUseEmergency = 
      this.circuitBreakerTripped ||
      volatility.overallVolatility > 0.8 ||
      liquidity < this.config.liquidityThresholdUsd * 0.1;

    return {
      currentLimit: shouldUseEmergency ? this.config.emergencySlippagePercent : dynamicResult.recommendedSlippage,
      baseLimit: this.config.baseSlippagePercent,
      adjustedForVolatility: this.config.baseSlippagePercent + dynamicResult.volatilityAdjustment,
      adjustedForLiquidity: this.config.baseSlippagePercent + dynamicResult.liquidityAdjustment,
      adjustedForSize: this.config.baseSlippagePercent + dynamicResult.riskAdjustment,
      emergencyLimit: this.config.emergencySlippagePercent,
      shouldUseEmergency,
    };
  }

  /**
   * Estimate market impact for a trade
   */
  public async estimateMarketImpact(
    poolAddress: string,
    tradeAmountUsd: number
  ): Promise<MarketImpactEstimation> {
    try {
      const liquidity = this.liquidityCache.get(poolAddress) || 100000; // Default $100k
      
      // Simplified market impact model
      // Real implementation would use order book depth and historical data
      const liquidityRatio = tradeAmountUsd / liquidity;
      const baseImpact = Math.sqrt(liquidityRatio) * 0.1; // Square root model
      
      // Adjust for pool characteristics
      let adjustedImpact = baseImpact;
      
      // Higher impact for small pools
      if (liquidity < 50000) {
        adjustedImpact *= 1.5;
      }
      
      // Lower impact for very liquid pools
      if (liquidity > 1000000) {
        adjustedImpact *= 0.7;
      }

      const confidenceLevel = Math.max(0.1, Math.min(1.0, liquidity / 500000));
      const orderBookImbalance = (Math.random() - 0.5) * 0.2; // Mock imbalance
      const recommendedMaxTradeSize = liquidity * 0.02; // 2% of liquidity

      return {
        estimatedImpact: Math.min(0.15, adjustedImpact), // Cap at 15%
        confidenceLevel,
        liquidityDepth: liquidity,
        orderBookImbalance,
        recommendedMaxTradeSize,
      };
    } catch (error) {
      this.logger.error('Failed to estimate market impact:', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        estimatedImpact: 0.05, // Conservative 5% estimate
        confidenceLevel: 0.3,
        liquidityDepth: 100000,
        orderBookImbalance: 0,
        recommendedMaxTradeSize: 2000,
      };
    }
  }

  /**
   * Get volatility metrics for a token
   */
  public async getVolatilityMetrics(tokenAddress: string): Promise<VolatilityMetrics> {
    // Check cache first
    const cached = this.volatilityCache.get(tokenAddress);
    if (cached && Date.now() - cached.timeWindow < 60000) { // 1 minute cache
      return cached;
    }

    try {
      // Get price history for volatility calculation
      const priceHistory = this.priceHistory.get(tokenAddress) || [];
      
      if (priceHistory.length < 10) {
        // Not enough data - return low volatility
        const metrics: VolatilityMetrics = {
          priceVolatility: 0.1,
          volumeVolatility: 0.1,
          liquidityVolatility: 0.1,
          overallVolatility: 0.1,
          timeWindow: Date.now(),
        };
        
        this.volatilityCache.set(tokenAddress, metrics);
        return metrics;
      }

      // Calculate price volatility (standard deviation of returns)
      const returns = [];
      for (let i = 1; i < priceHistory.length; i++) {
        const returnPct = (priceHistory[i].price - priceHistory[i-1].price) / priceHistory[i-1].price;
        returns.push(returnPct);
      }

      const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
      const priceVolatility = Math.sqrt(variance);

      // Mock volume and liquidity volatility (would need real data)
      const volumeVolatility = priceVolatility * 0.8;
      const liquidityVolatility = priceVolatility * 0.6;

      const overallVolatility = (priceVolatility + volumeVolatility + liquidityVolatility) / 3;

      const metrics: VolatilityMetrics = {
        priceVolatility: Math.min(1.0, priceVolatility),
        volumeVolatility: Math.min(1.0, volumeVolatility),
        liquidityVolatility: Math.min(1.0, liquidityVolatility),
        overallVolatility: Math.min(1.0, overallVolatility),
        timeWindow: Date.now(),
      };

      this.volatilityCache.set(tokenAddress, metrics);
      return metrics;
    } catch (error) {
      this.logger.error('Failed to get volatility metrics:', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return moderate volatility as fallback
      const fallback: VolatilityMetrics = {
        priceVolatility: 0.3,
        volumeVolatility: 0.3,
        liquidityVolatility: 0.3,
        overallVolatility: 0.3,
        timeWindow: Date.now(),
      };

      return fallback;
    }
  }

  /**
   * Trigger emergency circuit breaker
   */
  public triggerCircuitBreaker(reason: string, resetTimeoutMs: number = 5 * 60 * 1000): void {
    this.circuitBreakerTripped = true;
    this.logger.warning('Slippage protection circuit breaker triggered', { reason });

    // Auto-reset after specified timeout
    setTimeout(() => {
      this.circuitBreakerTripped = false;
      this.logger.info('Slippage protection circuit breaker reset');
    }, resetTimeoutMs);
  }

  /**
   * Check if circuit breaker is active
   */
  public isCircuitBreakerActive(): boolean {
    return this.circuitBreakerTripped;
  }

  /**
   * Update price data for volatility calculations
   */
  public updatePriceData(tokenAddress: string, price: number): void {
    let history = this.priceHistory.get(tokenAddress) || [];
    
    history.push({
      price,
      timestamp: Date.now(),
    });

    // Keep only last 100 data points
    if (history.length > 100) {
      history = history.slice(-100);
    }

    // Remove data older than 24 hours
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    history = history.filter(h => h.timestamp > dayAgo);

    this.priceHistory.set(tokenAddress, history);
  }

  /**
   * Update liquidity data
   */
  public updateLiquidityData(poolAddress: string, liquidityUsd: number): void {
    this.liquidityCache.set(poolAddress, liquidityUsd);
  }

  /**
   * Start background volatility monitoring
   */
  private startVolatilityMonitoring(): void {
    setInterval(() => {
      // Clean up old cache entries
      const now = Date.now();
      for (const [key, metrics] of this.volatilityCache.entries()) {
        if (now - metrics.timeWindow > 5 * 60 * 1000) { // 5 minutes
          this.volatilityCache.delete(key);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Start background liquidity monitoring
   */
  private startLiquidityMonitoring(): void {
    setInterval(() => {
      // This would fetch current liquidity data from DEXes
      // For now, just log cache status
      this.logger.debug('Liquidity cache status', {
        poolsTracked: this.liquidityCache.size,
      });
    }, 30000); // Every 30 seconds
  }

  /**
   * Get protection statistics
   */
  public getStats(): {
    volatilityCacheSize: number;
    liquidityCacheSize: number;
    priceHistorySize: number;
    circuitBreakerActive: boolean;
    config: SlippageProtectionConfig;
  } {
    return {
      volatilityCacheSize: this.volatilityCache.size,
      liquidityCacheSize: this.liquidityCache.size,
      priceHistorySize: this.priceHistory.size,
      circuitBreakerActive: this.circuitBreakerTripped,
      config: this.config,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<SlippageProtectionConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Slippage protection configuration updated', { config });
  }
}