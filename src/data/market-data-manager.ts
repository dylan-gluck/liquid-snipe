import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';
import { PriceFeedService, PriceData, PoolData, PriceUpdateEvent } from './price-feed-service';

/**
 * Market condition assessment
 */
export interface MarketCondition {
  timestamp: number;
  volatility: 'low' | 'medium' | 'high' | 'extreme';
  sentiment: 'bearish' | 'neutral' | 'bullish';
  liquidityScore: number; // 0-10 scale
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  recommendedAction: 'buy' | 'sell' | 'hold' | 'avoid';
  factors: {
    priceMovement24h: number;
    volumeChange24h: number;
    liquidityDepth: number;
    spreadAnalysis: number;
  };
}

/**
 * Token performance metrics
 */
export interface TokenMetrics {
  address: string;
  symbol?: string;
  performance: {
    price1h?: number;
    price24h?: number;
    price7d?: number;
    volume24h?: number;
    liquidityScore: number;
    volatilityIndex: number;
  };
  technicalIndicators: {
    rsi?: number;
    sma?: number;
    ema?: number;
    bollinger?: {
      upper: number;
      middle: number;
      lower: number;
    };
  };
  socialMetrics?: {
    mentions24h?: number;
    sentiment?: number;
    trendingScore?: number;
  };
}

/**
 * Portfolio exposure tracking
 */
export interface PortfolioExposure {
  totalValueUsd: number;
  positions: Array<{
    tokenAddress: string;
    symbol?: string;
    valueUsd: number;
    percentage: number;
    unrealizedPnL: number;
    riskScore: number;
  }>;
  diversification: {
    score: number; // 0-10
    concentrationRisk: number;
    sectorExposure: Record<string, number>;
  };
  riskMetrics: {
    var95: number; // Value at Risk 95%
    maxDrawdown: number;
    sharpeRatio?: number;
    volatility: number;
  };
}

/**
 * Comprehensive market data management with real-time monitoring
 */
export class MarketDataManager extends EventEmitter {
  private logger: Logger;
  private priceFeedService: PriceFeedService;
  private monitoredTokens: Set<string> = new Set();
  private marketConditions: Map<string, MarketCondition> = new Map();
  private tokenMetrics: Map<string, TokenMetrics> = new Map();
  private priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();
  private portfolioExposure?: PortfolioExposure;
  private monitoringInterval?: NodeJS.Timeout;

  // Configuration
  private readonly maxPriceHistory = 1000; // Keep last 1000 price points per token
  private readonly monitoringIntervalMs = 30000; // 30 seconds
  private readonly volatilityWindow = 24 * 60 * 60 * 1000; // 24 hours

  constructor(priceFeedService: PriceFeedService) {
    super();
    this.logger = new Logger('MarketDataManager');
    this.priceFeedService = priceFeedService;

    // Listen to price updates from the price feed service
    this.priceFeedService.on('priceUpdate', (update: PriceUpdateEvent) => {
      this.handlePriceUpdate(update);
    });

    this.priceFeedService.on('poolUpdate', (poolData: PoolData) => {
      this.handlePoolUpdate(poolData);
    });

    this.logger.info('MarketDataManager initialized');
  }

  /**
   * Start monitoring specific tokens
   */
  public startMonitoring(tokenAddresses: string[]): void {
    tokenAddresses.forEach(address => {
      this.monitoredTokens.add(address);
    });

    this.logger.info(`Started monitoring ${tokenAddresses.length} tokens`);

    // Start real-time price monitoring
    this.priceFeedService.startRealTimeMonitoring(Array.from(this.monitoredTokens));

    // Start periodic market analysis
    if (!this.monitoringInterval) {
      this.monitoringInterval = setInterval(() => {
        this.performMarketAnalysis();
      }, this.monitoringIntervalMs);
    }
  }

  /**
   * Stop monitoring specific tokens
   */
  public stopMonitoring(tokenAddresses?: string[]): void {
    if (tokenAddresses) {
      tokenAddresses.forEach(address => {
        this.monitoredTokens.delete(address);
        this.priceFeedService.stopRealTimeMonitoring(address);
      });
    } else {
      // Stop all monitoring
      this.monitoredTokens.clear();
      this.priceFeedService.stopRealTimeMonitoring();
      
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = undefined;
      }
    }

    this.logger.info(`Stopped monitoring ${tokenAddresses?.length || 'all'} tokens`);
  }

  /**
   * Get current market condition for a token
   */
  public getMarketCondition(tokenAddress: string): MarketCondition | null {
    return this.marketConditions.get(tokenAddress) || null;
  }

  /**
   * Get token metrics and performance data
   */
  public getTokenMetrics(tokenAddress: string): TokenMetrics | null {
    return this.tokenMetrics.get(tokenAddress) || null;
  }

  /**
   * Get portfolio exposure analysis
   */
  public getPortfolioExposure(): PortfolioExposure | null {
    return this.portfolioExposure || null;
  }

  /**
   * Update portfolio positions for risk analysis
   */
  public updatePortfolioPositions(positions: Array<{
    tokenAddress: string;
    valueUsd: number;
    entryPrice: number;
    currentPrice?: number;
  }>): void {
    const totalValue = positions.reduce((sum, pos) => sum + pos.valueUsd, 0);
    
    const portfolioPositions = positions.map(pos => {
      const currentPrice = pos.currentPrice || pos.entryPrice;
      const unrealizedPnL = ((currentPrice - pos.entryPrice) / pos.entryPrice) * pos.valueUsd;
      
      return {
        tokenAddress: pos.tokenAddress,
        symbol: this.tokenMetrics.get(pos.tokenAddress)?.symbol,
        valueUsd: pos.valueUsd,
        percentage: (pos.valueUsd / totalValue) * 100,
        unrealizedPnL,
        riskScore: this.calculatePositionRisk(pos.tokenAddress),
      };
    });

    // Calculate diversification metrics
    const diversificationScore = this.calculateDiversificationScore(portfolioPositions);
    const concentrationRisk = Math.max(...portfolioPositions.map(p => p.percentage));

    // Calculate risk metrics
    const riskMetrics = this.calculatePortfolioRisk(portfolioPositions);

    this.portfolioExposure = {
      totalValueUsd: totalValue,
      positions: portfolioPositions,
      diversification: {
        score: diversificationScore,
        concentrationRisk,
        sectorExposure: {}, // Would be enhanced with sector classification
      },
      riskMetrics,
    };

    this.emit('portfolioUpdate', this.portfolioExposure);
  }

  /**
   * Assess if market conditions are favorable for trading
   */
  public isMarketFavorable(tokenAddress?: string): {
    favorable: boolean;
    confidence: number;
    reasoning: string;
    conditions: MarketCondition | null;
  } {
    let overallCondition: MarketCondition | null = null;

    if (tokenAddress) {
      overallCondition = this.marketConditions.get(tokenAddress) || null;
    } else {
      // Aggregate market conditions for all monitored tokens
      overallCondition = this.aggregateMarketConditions();
    }

    if (!overallCondition) {
      return {
        favorable: false,
        confidence: 0,
        reasoning: 'No market data available',
        conditions: null,
      };
    }

    // Decision logic based on market conditions
    let favorable = false;
    let confidence = 0;
    let reasoning = '';

    const { volatility, sentiment, liquidityScore, riskLevel } = overallCondition;

    // Favorable conditions: low-medium volatility, neutral-bullish sentiment, good liquidity
    if (volatility === 'low' || volatility === 'medium') {
      if (sentiment === 'bullish' && liquidityScore >= 6 && riskLevel !== 'extreme') {
        favorable = true;
        confidence = 0.8;
        reasoning = 'Bullish sentiment with good liquidity and manageable risk';
      } else if (sentiment === 'neutral' && liquidityScore >= 7 && riskLevel === 'low') {
        favorable = true;
        confidence = 0.6;
        reasoning = 'Stable conditions with excellent liquidity and low risk';
      } else {
        favorable = false;
        confidence = 0.3;
        reasoning = 'Suboptimal sentiment or liquidity conditions';
      }
    } else {
      favorable = false;
      confidence = 0.1;
      reasoning = `High volatility (${volatility}) makes trading risky`;
    }

    return {
      favorable,
      confidence,
      reasoning,
      conditions: overallCondition,
    };
  }

  /**
   * Get recommended position size based on market conditions
   */
  public getRecommendedPositionSize(
    tokenAddress: string,
    availableCapital: number,
    maxRiskPercent: number
  ): {
    recommendedSize: number;
    reasoning: string;
    marketCondition: MarketCondition | null;
  } {
    const condition = this.marketConditions.get(tokenAddress);
    const metrics = this.tokenMetrics.get(tokenAddress);
    
    if (!condition) {
      return {
        recommendedSize: 0,
        reasoning: 'No market condition data available',
        marketCondition: null,
      };
    }

    let sizeMultiplier = 1.0;
    const reasons: string[] = [];

    // Adjust based on volatility
    switch (condition.volatility) {
      case 'low':
        sizeMultiplier *= 1.2;
        reasons.push('Low volatility allows larger position');
        break;
      case 'medium':
        sizeMultiplier *= 1.0;
        break;
      case 'high':
        sizeMultiplier *= 0.7;
        reasons.push('High volatility requires smaller position');
        break;
      case 'extreme':
        sizeMultiplier *= 0.3;
        reasons.push('Extreme volatility requires minimal position');
        break;
    }

    // Adjust based on liquidity
    if (condition.liquidityScore >= 8) {
      sizeMultiplier *= 1.1;
      reasons.push('Excellent liquidity supports larger position');
    } else if (condition.liquidityScore < 5) {
      sizeMultiplier *= 0.7;
      reasons.push('Poor liquidity requires smaller position');
    }

    // Adjust based on sentiment
    if (condition.sentiment === 'bullish') {
      sizeMultiplier *= 1.1;
      reasons.push('Bullish sentiment supports larger position');
    } else if (condition.sentiment === 'bearish') {
      sizeMultiplier *= 0.6;
      reasons.push('Bearish sentiment requires smaller position');
    }

    // Portfolio concentration check
    if (this.portfolioExposure) {
      const currentExposure = this.portfolioExposure.positions.find(p => p.tokenAddress === tokenAddress);
      if (currentExposure && currentExposure.percentage > 10) {
        sizeMultiplier *= 0.5;
        reasons.push('Already high exposure to this token');
      }
    }

    const baseSize = availableCapital * (maxRiskPercent / 100);
    const recommendedSize = Math.max(baseSize * sizeMultiplier, 0);

    return {
      recommendedSize,
      reasoning: reasons.join('; ') || 'Standard position sizing',
      marketCondition: condition,
    };
  }

  /**
   * Handle price updates from the feed service
   */
  private handlePriceUpdate(update: PriceUpdateEvent): void {
    const { address, price, timestamp } = update;
    
    // Update price history
    let history = this.priceHistory.get(address) || [];
    history.push({ price, timestamp });
    
    // Keep only recent history
    if (history.length > this.maxPriceHistory) {
      history = history.slice(-this.maxPriceHistory);
    }
    
    this.priceHistory.set(address, history);

    // Update token metrics
    this.updateTokenMetrics(address, history);

    // Emit market data update
    this.emit('marketDataUpdate', { address, price, timestamp });
  }

  /**
   * Handle pool updates from the feed service
   */
  private handlePoolUpdate(poolData: PoolData): void {
    // Update liquidity information for relevant tokens
    const tokenAddresses = [poolData.tokenA.address, poolData.tokenB.address];
    
    tokenAddresses.forEach(address => {
      if (this.monitoredTokens.has(address)) {
        this.updateTokenLiquidityMetrics(address, poolData);
      }
    });
  }

  /**
   * Perform comprehensive market analysis
   */
  private async performMarketAnalysis(): Promise<void> {
    try {
      for (const tokenAddress of this.monitoredTokens) {
        await this.analyzeTokenMarketCondition(tokenAddress);
      }
    } catch (error) {
      this.logger.error('Failed to perform market analysis', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Analyze market condition for a specific token
   */
  private async analyzeTokenMarketCondition(tokenAddress: string): Promise<void> {
    const priceHistory = this.priceHistory.get(tokenAddress) || [];
    
    if (priceHistory.length < 10) {
      return; // Not enough data for analysis
    }

    // Calculate volatility
    const volatility = this.calculateVolatility(priceHistory);
    
    // Calculate sentiment based on recent price action
    const sentiment = this.calculateSentiment(priceHistory);
    
    // Get current liquidity score
    const liquidityScore = await this.calculateLiquidityScore(tokenAddress);
    
    // Assess overall risk
    const riskLevel = this.assessRiskLevel(volatility, sentiment, liquidityScore);
    
    // Determine recommended action
    const recommendedAction = this.determineRecommendedAction(volatility, sentiment, liquidityScore, riskLevel);

    // Calculate supporting factors
    const factors = this.calculateMarketFactors(priceHistory, liquidityScore);

    const condition: MarketCondition = {
      timestamp: Date.now(),
      volatility,
      sentiment,
      liquidityScore,
      riskLevel,
      recommendedAction,
      factors,
    };

    this.marketConditions.set(tokenAddress, condition);
    this.emit('marketConditionUpdate', { address: tokenAddress, condition });
  }

  /**
   * Calculate price volatility
   */
  private calculateVolatility(priceHistory: Array<{ price: number; timestamp: number }>): 'low' | 'medium' | 'high' | 'extreme' {
    if (priceHistory.length < 2) return 'medium';

    const returns = [];
    for (let i = 1; i < priceHistory.length; i++) {
      const prevPrice = priceHistory[i - 1].price;
      const currentPrice = priceHistory[i].price;
      if (prevPrice > 0) {
        returns.push((currentPrice - prevPrice) / prevPrice);
      }
    }

    if (returns.length === 0) return 'medium';

    // Calculate standard deviation of returns
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Classify volatility based on standard deviation
    if (stdDev < 0.02) return 'low';
    if (stdDev < 0.05) return 'medium';
    if (stdDev < 0.15) return 'high';
    return 'extreme';
  }

  /**
   * Calculate market sentiment based on price action
   */
  private calculateSentiment(priceHistory: Array<{ price: number; timestamp: number }>): 'bearish' | 'neutral' | 'bullish' {
    if (priceHistory.length < 10) return 'neutral';

    // Look at recent trend (last 10 points)
    const recentPrices = priceHistory.slice(-10);
    const firstPrice = recentPrices[0].price;
    const lastPrice = recentPrices[recentPrices.length - 1].price;
    
    const priceChange = (lastPrice - firstPrice) / firstPrice;

    // Count upward vs downward movements
    let upMoves = 0;
    let downMoves = 0;
    
    for (let i = 1; i < recentPrices.length; i++) {
      if (recentPrices[i].price > recentPrices[i - 1].price) {
        upMoves++;
      } else if (recentPrices[i].price < recentPrices[i - 1].price) {
        downMoves++;
      }
    }

    const trendStrength = upMoves / (upMoves + downMoves);

    // Combine price change and trend strength
    if (priceChange > 0.05 && trendStrength > 0.6) return 'bullish';
    if (priceChange < -0.05 && trendStrength < 0.4) return 'bearish';
    return 'neutral';
  }

  /**
   * Calculate liquidity score for a token
   */
  private async calculateLiquidityScore(tokenAddress: string): Promise<number> {
    try {
      const priceData = await this.priceFeedService.getTokenPrice(tokenAddress);
      
      if (!priceData || !priceData.volume24h) {
        return 3; // Default medium score
      }

      // Score based on 24h volume (simplified scoring)
      const volume = priceData.volume24h;
      
      if (volume > 1000000) return 9; // Excellent liquidity
      if (volume > 500000) return 8;
      if (volume > 100000) return 7;
      if (volume > 50000) return 6;
      if (volume > 10000) return 5;
      if (volume > 5000) return 4;
      if (volume > 1000) return 3;
      if (volume > 100) return 2;
      return 1; // Poor liquidity

    } catch (error) {
      this.logger.debug(`Failed to calculate liquidity score for ${tokenAddress}`, { error });
      return 3; // Default score on error
    }
  }

  /**
   * Additional helper methods would go here...
   */
  private assessRiskLevel(volatility: string, sentiment: string, liquidityScore: number): 'low' | 'medium' | 'high' | 'extreme' {
    let riskScore = 0;
    
    // Volatility contribution
    switch (volatility) {
      case 'low': riskScore += 1; break;
      case 'medium': riskScore += 2; break;
      case 'high': riskScore += 3; break;
      case 'extreme': riskScore += 4; break;
    }
    
    // Liquidity contribution (inverse)
    if (liquidityScore < 3) riskScore += 2;
    else if (liquidityScore < 6) riskScore += 1;
    
    // Sentiment contribution
    if (sentiment === 'bearish') riskScore += 1;
    
    if (riskScore <= 2) return 'low';
    if (riskScore <= 3) return 'medium';
    if (riskScore <= 5) return 'high';
    return 'extreme';
  }

  private determineRecommendedAction(volatility: string, sentiment: string, liquidityScore: number, riskLevel: string): 'buy' | 'sell' | 'hold' | 'avoid' {
    if (riskLevel === 'extreme' || liquidityScore < 3) return 'avoid';
    if (sentiment === 'bullish' && riskLevel === 'low') return 'buy';
    if (sentiment === 'bearish' && volatility === 'high') return 'sell';
    if (volatility === 'extreme') return 'avoid';
    return 'hold';
  }

  private calculateMarketFactors(priceHistory: Array<{ price: number; timestamp: number }>, liquidityScore: number) {
    const recentPrices = priceHistory.slice(-24); // Last 24 data points
    if (recentPrices.length < 2) {
      return {
        priceMovement24h: 0,
        volumeChange24h: 0,
        liquidityDepth: liquidityScore,
        spreadAnalysis: 5, // Default medium spread
      };
    }

    const firstPrice = recentPrices[0].price;
    const lastPrice = recentPrices[recentPrices.length - 1].price;
    const priceMovement24h = ((lastPrice - firstPrice) / firstPrice) * 100;

    return {
      priceMovement24h,
      volumeChange24h: 0, // Would need historical volume data
      liquidityDepth: liquidityScore,
      spreadAnalysis: 5, // Would calculate from bid-ask spread if available
    };
  }

  private updateTokenMetrics(address: string, priceHistory: Array<{ price: number; timestamp: number }>): void {
    // Implementation would calculate various technical indicators
    // This is a simplified version
    const metrics: TokenMetrics = {
      address,
      performance: {
        liquidityScore: 5, // Would be calculated from actual data
        volatilityIndex: this.calculateVolatilityIndex(priceHistory),
      },
      technicalIndicators: {
        // Technical indicators would be calculated here
      },
    };

    this.tokenMetrics.set(address, metrics);
  }

  private calculateVolatilityIndex(priceHistory: Array<{ price: number; timestamp: number }>): number {
    if (priceHistory.length < 10) return 50; // Default medium volatility

    const returns = [];
    for (let i = 1; i < priceHistory.length; i++) {
      const prevPrice = priceHistory[i - 1].price;
      const currentPrice = priceHistory[i].price;
      if (prevPrice > 0) {
        returns.push(Math.abs((currentPrice - prevPrice) / prevPrice));
      }
    }

    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    return Math.min(avgReturn * 1000, 100); // Scale to 0-100
  }

  private updateTokenLiquidityMetrics(address: string, poolData: PoolData): void {
    // Update liquidity metrics based on pool data
    const existingMetrics = this.tokenMetrics.get(address) || {
      address,
      performance: { liquidityScore: 0, volatilityIndex: 50 },
      technicalIndicators: {},
    };

    // Calculate liquidity score from pool data
    const liquidityScore = Math.min((poolData.totalLiquidityUsd / 100000) * 10, 10);
    
    existingMetrics.performance.liquidityScore = liquidityScore;
    this.tokenMetrics.set(address, existingMetrics);
  }

  private aggregateMarketConditions(): MarketCondition | null {
    const conditions = Array.from(this.marketConditions.values());
    if (conditions.length === 0) return null;

    // Simple aggregation - in practice would be more sophisticated
    const avgLiquidity = conditions.reduce((sum, c) => sum + c.liquidityScore, 0) / conditions.length;
    
    return {
      timestamp: Date.now(),
      volatility: 'medium', // Would aggregate properly
      sentiment: 'neutral', // Would aggregate properly
      liquidityScore: avgLiquidity,
      riskLevel: 'medium', // Would aggregate properly
      recommendedAction: 'hold',
      factors: {
        priceMovement24h: 0,
        volumeChange24h: 0,
        liquidityDepth: avgLiquidity,
        spreadAnalysis: 5,
      },
    };
  }

  private calculateDiversificationScore(positions: any[]): number {
    // Simple diversification calculation based on position count and distribution
    const positionCount = positions.length;
    const maxConcentration = Math.max(...positions.map(p => p.percentage));
    
    let score = Math.min(positionCount * 2, 10); // More positions = better diversification
    score -= Math.max(0, (maxConcentration - 20) / 10); // Penalty for concentration > 20%
    
    return Math.max(0, Math.min(score, 10));
  }

  private calculatePositionRisk(tokenAddress: string): number {
    const condition = this.marketConditions.get(tokenAddress);
    if (!condition) return 5; // Default medium risk

    let riskScore = 5;
    
    switch (condition.riskLevel) {
      case 'low': riskScore = 2; break;
      case 'medium': riskScore = 4; break;
      case 'high': riskScore = 7; break;
      case 'extreme': riskScore = 9; break;
    }

    return riskScore;
  }

  private calculatePortfolioRisk(positions: any[]) {
    // Simplified portfolio risk calculation
    const avgRisk = positions.reduce((sum, p) => sum + p.riskScore, 0) / positions.length;
    const maxDrawdown = Math.max(...positions.map(p => Math.abs(Math.min(p.unrealizedPnL / p.valueUsd * 100, 0))));
    
    return {
      var95: avgRisk * 0.1, // Simplified VaR calculation
      maxDrawdown,
      volatility: avgRisk,
    };
  }

  /**
   * Cleanup and shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down MarketDataManager');
    
    this.stopMonitoring();
    this.removeAllListeners();
    
    // Clear all data
    this.monitoredTokens.clear();
    this.marketConditions.clear();
    this.tokenMetrics.clear();
    this.priceHistory.clear();
  }
}