import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';
import { CircuitBreaker, CircuitBreakerRegistry } from '../core/circuit-breaker';
import { Position, Trade, TradeDecision } from '../types';

export interface RiskConfig {
  enabled: boolean;
  maxTotalExposure: number; // Maximum total USD exposure across all positions
  maxSinglePositionSize: number; // Maximum USD size for a single position
  maxPortfolioPercentage: number; // Maximum percentage of portfolio per position
  maxConcentrationRisk: number; // Maximum percentage in correlated assets
  maxDailyLoss: number; // Maximum daily loss before circuit breaker
  maxDrawdown: number; // Maximum drawdown percentage before shutdown
  volatilityMultiplier: number; // Position size adjustment based on volatility
  correlationThreshold: number; // Correlation threshold for risk grouping
  rebalanceThreshold: number; // Threshold for automatic rebalancing
  riskAssessmentInterval: number; // Milliseconds between risk assessments
  emergencyExitThreshold: number; // Emergency exit threshold percentage
}

export interface RiskAssessment {
  riskScore: number; // 0-100 risk score
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  exposureAnalysis: ExposureAnalysis;
  correlationRisk: CorrelationRisk;
  volatilityRisk: VolatilityRisk;
  liquidityRisk: LiquidityRisk;
  recommendations: RiskRecommendation[];
  timestamp: number;
}

export interface ExposureAnalysis {
  totalExposureUsd: number;
  totalPortfolioValue: number;
  exposurePercentage: number;
  largestPositionSize: number;
  positionCount: number;
  averagePositionSize: number;
  exposureByToken: Record<string, number>;
  exposureByDex: Record<string, number>;
}

export interface CorrelationRisk {
  correlationScore: number; // 0-100, higher means more correlated risk
  correlatedGroups: CorrelatedGroup[];
  diversificationScore: number; // 0-100, higher means better diversified
  maxCorrelatedExposure: number;
}

export interface CorrelatedGroup {
  tokens: string[];
  correlation: number;
  totalExposure: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface VolatilityRisk {
  averageVolatility: number;
  maxVolatility: number;
  volatilityScore: number; // 0-100 risk score
  highVolatilityPositions: string[];
  positionSizeAdjustments: Record<string, number>;
}

export interface LiquidityRisk {
  averageLiquidity: number;
  minLiquidity: number;
  liquidityScore: number; // 0-100 risk score
  lowLiquidityPositions: string[];
  liquidityWarnings: string[];
}

export interface RiskRecommendation {
  type: 'REDUCE_POSITION' | 'EXIT_POSITION' | 'STOP_TRADING' | 'REBALANCE' | 'INCREASE_STOPS';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  tokenAddress?: string;
  suggestedAction: string;
  rationale: string;
}

export interface RiskMetrics {
  totalValue: number;
  totalPnl: number;
  dailyPnl: number;
  drawdown: number;
  maxDrawdown: number;
  winRate: number;
  sharpeRatio: number;
  volatility: number;
  varDaily: number; // Value at Risk (daily)
  positions: RiskPositionMetrics[];
}

export interface RiskPositionMetrics {
  tokenAddress: string;
  value: number;
  pnl: number;
  pnlPercentage: number;
  volatility: number;
  liquidity: number;
  riskScore: number;
  correlation: number;
  holdingTime: number;
}

export interface RiskAlert {
  type: 'EXPOSURE_LIMIT' | 'CORRELATION_RISK' | 'VOLATILITY_SPIKE' | 'LIQUIDITY_DRAIN' | 'DAILY_LOSS' | 'DRAWDOWN';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  tokenAddress?: string;
  currentValue: number;
  threshold: number;
  recommendation: string;
  timestamp: number;
}

/**
 * Comprehensive risk management system for portfolio exposure and risk control
 */
export class RiskManager extends EventEmitter {
  private logger: Logger;
  private config: RiskConfig;
  private circuitBreakerRegistry: CircuitBreakerRegistry;
  private assessmentInterval?: NodeJS.Timeout;
  private isRunning = false;

  // Risk tracking
  private currentMetrics?: RiskMetrics;
  private currentAssessment?: RiskAssessment;
  private dailyStartValue = 0;
  private maxDrawdownSeen = 0;
  private lastAssessmentTime = 0;

  // Position tracking
  private positions = new Map<string, Position>();
  private trades = new Map<string, Trade>();
  private priceHistory = new Map<string, number[]>();
  private correlationMatrix = new Map<string, Map<string, number>>();

  constructor(config: RiskConfig) {
    super();
    this.config = config;
    this.logger = new Logger('RiskManager');
    this.circuitBreakerRegistry = new CircuitBreakerRegistry();

    this.setupCircuitBreakers();
    this.initializeDailyTracking();
  }

  /**
   * Setup circuit breakers for risk management operations
   */
  private setupCircuitBreakers(): void {
    this.circuitBreakerRegistry.getOrCreate('risk-assessment', {
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 30000,
      monitoringPeriod: 60000,
      name: 'risk-assessment',
    });

    this.circuitBreakerRegistry.getOrCreate('position-tracking', {
      failureThreshold: 5,
      successThreshold: 3,
      timeout: 15000,
      monitoringPeriod: 30000,
      name: 'position-tracking',
    });
  }

  /**
   * Initialize daily tracking metrics
   */
  private initializeDailyTracking(): void {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Reset daily metrics at start of day
    if (now.getTime() - startOfDay.getTime() < 60000) { // Within first minute of day
      this.dailyStartValue = 0;
      this.maxDrawdownSeen = 0;
    }
  }

  /**
   * Start risk management monitoring
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warning('Risk manager is already running');
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('Risk management is disabled');
      return;
    }

    this.logger.info('Starting risk management system');
    this.isRunning = true;

    // Start periodic risk assessment
    this.assessmentInterval = setInterval(
      () => this.performRiskAssessment(),
      this.config.riskAssessmentInterval
    );

    // Perform initial assessment
    await this.performRiskAssessment();

    this.emit('started');
  }

  /**
   * Stop risk management monitoring
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping risk management system');
    this.isRunning = false;

    if (this.assessmentInterval) {
      clearInterval(this.assessmentInterval);
      this.assessmentInterval = undefined;
    }

    this.emit('stopped');
  }

  /**
   * Assess risk for a potential trade
   */
  public async assessTradeRisk(decision: TradeDecision): Promise<RiskAssessment> {
    const circuitBreaker = this.circuitBreakerRegistry.get('risk-assessment')!;

    return circuitBreaker.execute(async () => {
      // Calculate current exposure
      const currentExposure = this.calculateTotalExposure();
      const newExposure = currentExposure + decision.tradeAmountUsd;

      // Check exposure limits
      if (newExposure > this.config.maxTotalExposure) {
        this.emitRiskAlert({
          type: 'EXPOSURE_LIMIT',
          severity: 'CRITICAL',
          message: `Trade would exceed maximum total exposure limit`,
          currentValue: newExposure,
          threshold: this.config.maxTotalExposure,
          recommendation: 'Reject trade or reduce position size',
          timestamp: Date.now(),
        });
      }

      // Check single position size
      if (decision.tradeAmountUsd > this.config.maxSinglePositionSize) {
        this.emitRiskAlert({
          type: 'EXPOSURE_LIMIT',
          severity: 'HIGH',
          message: `Trade exceeds maximum single position size`,
          tokenAddress: decision.targetToken,
          currentValue: decision.tradeAmountUsd,
          threshold: this.config.maxSinglePositionSize,
          recommendation: 'Reduce position size',
          timestamp: Date.now(),
        });
      }

      // Perform comprehensive risk assessment
      const assessment = await this.calculateRiskAssessment(decision);
      
      this.emit('tradeRiskAssessed', { decision, assessment });
      return assessment;
    });
  }

  /**
   * Update position information
   */
  public updatePosition(position: Position): void {
    const circuitBreaker = this.circuitBreakerRegistry.get('position-tracking')!;

    circuitBreaker.execute(async () => {
      this.positions.set(position.id, position);
      this.emit('positionUpdated', position);
      
      // Trigger risk assessment if significant change
      const currentTime = Date.now();
      if (currentTime - this.lastAssessmentTime > this.config.riskAssessmentInterval / 2) {
        await this.performRiskAssessment();
      }
    }).catch(error => {
      this.logger.error('Failed to update position:', error as Record<string, any>);
    });
  }

  /**
   * Update trade information
   */
  public updateTrade(trade: Trade): void {
    this.trades.set(trade.id, trade);
    
    // Update daily tracking
    if (this.dailyStartValue === 0) {
      this.dailyStartValue = this.calculateTotalValue();
    }

    this.emit('tradeUpdated', trade);
  }

  /**
   * Update price data for correlation analysis
   */
  public updatePriceData(tokenAddress: string, price: number): void {
    if (!this.priceHistory.has(tokenAddress)) {
      this.priceHistory.set(tokenAddress, []);
    }

    const history = this.priceHistory.get(tokenAddress)!;
    history.push(price);

    // Keep only last 100 prices for performance
    if (history.length > 100) {
      history.shift();
    }

    // Update correlation matrix periodically
    if (history.length >= 20) {
      this.updateCorrelationMatrix();
    }
  }

  /**
   * Perform comprehensive risk assessment
   */
  private async performRiskAssessment(): Promise<void> {
    try {
      const assessment = await this.calculateRiskAssessment();
      this.currentAssessment = assessment;
      this.currentMetrics = this.calculateRiskMetrics();
      this.lastAssessmentTime = Date.now();

      // Check for risk alerts
      await this.checkRiskThresholds(assessment);

      this.emit('riskAssessment', assessment);
    } catch (error) {
      this.logger.error('Risk assessment failed:', error as Record<string, any>);
      this.emit('riskAssessmentError', error);
    }
  }

  /**
   * Calculate comprehensive risk assessment
   */
  private async calculateRiskAssessment(pendingTrade?: TradeDecision): Promise<RiskAssessment> {
    const exposureAnalysis = this.calculateExposureAnalysis(pendingTrade);
    const correlationRisk = this.calculateCorrelationRisk();
    const volatilityRisk = this.calculateVolatilityRisk();
    const liquidityRisk = this.calculateLiquidityRisk();

    // Calculate overall risk score (0-100)
    const riskScore = this.calculateOverallRiskScore(
      exposureAnalysis,
      correlationRisk,
      volatilityRisk,
      liquidityRisk
    );

    const riskLevel = this.determineRiskLevel(riskScore);
    const recommendations = this.generateRecommendations(
      exposureAnalysis,
      correlationRisk,
      volatilityRisk,
      liquidityRisk,
      riskLevel
    );

    return {
      riskScore,
      riskLevel,
      exposureAnalysis,
      correlationRisk,
      volatilityRisk,
      liquidityRisk,
      recommendations,
      timestamp: Date.now(),
    };
  }

  /**
   * Calculate exposure analysis
   */
  private calculateExposureAnalysis(pendingTrade?: TradeDecision): ExposureAnalysis {
    const positions = Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
    
    let totalExposureUsd = 0;
    let largestPositionSize = 0;
    const exposureByToken: Record<string, number> = {};
    const exposureByDex: Record<string, number> = {};

    positions.forEach(position => {
      const positionValue = position.amount * (position.entryPrice || 0);
      totalExposureUsd += positionValue;
      largestPositionSize = Math.max(largestPositionSize, positionValue);
      
      exposureByToken[position.tokenAddress] = 
        (exposureByToken[position.tokenAddress] || 0) + positionValue;
    });

    // Add pending trade if provided
    if (pendingTrade) {
      totalExposureUsd += pendingTrade.tradeAmountUsd;
      exposureByToken[pendingTrade.targetToken] = 
        (exposureByToken[pendingTrade.targetToken] || 0) + pendingTrade.tradeAmountUsd;
    }

    const totalPortfolioValue = this.calculateTotalValue();
    const exposurePercentage = totalPortfolioValue > 0 ? 
      (totalExposureUsd / totalPortfolioValue) * 100 : 0;

    return {
      totalExposureUsd,
      totalPortfolioValue,
      exposurePercentage,
      largestPositionSize,
      positionCount: positions.length,
      averagePositionSize: positions.length > 0 ? totalExposureUsd / positions.length : 0,
      exposureByToken,
      exposureByDex,
    };
  }

  /**
   * Calculate correlation risk
   */
  private calculateCorrelationRisk(): CorrelationRisk {
    const correlatedGroups: CorrelatedGroup[] = [];
    const tokens = Array.from(this.positions.keys());
    let maxCorrelatedExposure = 0;

    // Find correlated groups
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const correlation = this.getCorrelation(tokens[i], tokens[j]);
        
        if (correlation > this.config.correlationThreshold) {
          const token1Position = this.positions.get(tokens[i]);
          const token2Position = this.positions.get(tokens[j]);
          
          if (token1Position && token2Position) {
            const totalExposure = 
              (token1Position.amount * (token1Position.entryPrice || 0)) +
              (token2Position.amount * (token2Position.entryPrice || 0));

            correlatedGroups.push({
              tokens: [tokens[i], tokens[j]],
              correlation,
              totalExposure,
              riskLevel: this.determineCorrelationRiskLevel(correlation, totalExposure),
            });

            maxCorrelatedExposure = Math.max(maxCorrelatedExposure, totalExposure);
          }
        }
      }
    }

    const correlationScore = Math.min(100, (maxCorrelatedExposure / this.config.maxConcentrationRisk) * 100);
    const diversificationScore = Math.max(0, 100 - correlationScore);

    return {
      correlationScore,
      correlatedGroups,
      diversificationScore,
      maxCorrelatedExposure,
    };
  }

  /**
   * Calculate volatility risk
   */
  private calculateVolatilityRisk(): VolatilityRisk {
    const positions = Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
    const volatilities: number[] = [];
    const highVolatilityPositions: string[] = [];
    const positionSizeAdjustments: Record<string, number> = {};

    positions.forEach(position => {
      const volatility = this.calculateTokenVolatility(position.tokenAddress);
      volatilities.push(volatility);

      if (volatility > 50) { // High volatility threshold
        highVolatilityPositions.push(position.tokenAddress);
      }

      // Calculate position size adjustment based on volatility
      const adjustment = Math.max(0.1, 1 - (volatility / 100) * this.config.volatilityMultiplier);
      positionSizeAdjustments[position.tokenAddress] = adjustment;
    });

    const averageVolatility = volatilities.length > 0 ? 
      volatilities.reduce((sum, v) => sum + v, 0) / volatilities.length : 0;
    const maxVolatility = volatilities.length > 0 ? Math.max(...volatilities) : 0;
    const volatilityScore = Math.min(100, averageVolatility);

    return {
      averageVolatility,
      maxVolatility,
      volatilityScore,
      highVolatilityPositions,
      positionSizeAdjustments,
    };
  }

  /**
   * Calculate liquidity risk
   */
  private calculateLiquidityRisk(): LiquidityRisk {
    const positions = Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
    const liquidities: number[] = [];
    const lowLiquidityPositions: string[] = [];
    const liquidityWarnings: string[] = [];

    positions.forEach(position => {
      // This would typically get liquidity from external data source
      // For now, using placeholder logic
      const liquidity = 10000; // Placeholder
      liquidities.push(liquidity);

      if (liquidity < 5000) {
        lowLiquidityPositions.push(position.tokenAddress);
        liquidityWarnings.push(`Low liquidity detected for ${position.tokenAddress}: $${liquidity}`);
      }
    });

    const averageLiquidity = liquidities.length > 0 ? 
      liquidities.reduce((sum, l) => sum + l, 0) / liquidities.length : 0;
    const minLiquidity = liquidities.length > 0 ? Math.min(...liquidities) : 0;
    const liquidityScore = Math.min(100, (minLiquidity / 10000) * 100);

    return {
      averageLiquidity,
      minLiquidity,
      liquidityScore,
      lowLiquidityPositions,
      liquidityWarnings,
    };
  }

  /**
   * Calculate overall risk score
   */
  private calculateOverallRiskScore(
    exposure: ExposureAnalysis,
    correlation: CorrelationRisk,
    volatility: VolatilityRisk,
    liquidity: LiquidityRisk
  ): number {
    // Weighted risk score calculation
    const exposureWeight = 0.3;
    const correlationWeight = 0.25;
    const volatilityWeight = 0.25;
    const liquidityWeight = 0.2;

    const exposureScore = Math.min(100, (exposure.exposurePercentage / this.config.maxPortfolioPercentage) * 100);
    
    return Math.min(100,
      exposureScore * exposureWeight +
      correlation.correlationScore * correlationWeight +
      volatility.volatilityScore * volatilityWeight +
      (100 - liquidity.liquidityScore) * liquidityWeight
    );
  }

  /**
   * Determine risk level from score
   */
  private determineRiskLevel(score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (score >= 80) return 'CRITICAL';
    if (score >= 60) return 'HIGH';
    if (score >= 40) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Generate risk recommendations
   */
  private generateRecommendations(
    exposure: ExposureAnalysis,
    correlation: CorrelationRisk,
    volatility: VolatilityRisk,
    liquidity: LiquidityRisk,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  ): RiskRecommendation[] {
    const recommendations: RiskRecommendation[] = [];

    // Exposure recommendations
    if (exposure.exposurePercentage > this.config.maxPortfolioPercentage) {
      recommendations.push({
        type: 'REDUCE_POSITION',
        priority: 'HIGH',
        description: 'Portfolio exposure exceeds maximum threshold',
        suggestedAction: 'Reduce position sizes or exit some positions',
        rationale: `Current exposure: ${exposure.exposurePercentage.toFixed(1)}%, Max: ${this.config.maxPortfolioPercentage}%`,
      });
    }

    // Correlation recommendations
    correlation.correlatedGroups.forEach(group => {
      if (group.riskLevel === 'HIGH') {
        recommendations.push({
          type: 'REBALANCE',
          priority: 'MEDIUM',
          description: 'High correlation risk detected',
          suggestedAction: 'Diversify positions to reduce correlation',
          rationale: `Correlated tokens: ${group.tokens.join(', ')} (${(group.correlation * 100).toFixed(1)}% correlation)`,
        });
      }
    });

    // Volatility recommendations
    volatility.highVolatilityPositions.forEach(tokenAddress => {
      recommendations.push({
        type: 'INCREASE_STOPS',
        priority: 'MEDIUM',
        description: 'High volatility position detected',
        tokenAddress,
        suggestedAction: 'Tighten stop losses and reduce position size',
        rationale: 'High volatility increases risk of large losses',
      });
    });

    // Liquidity recommendations
    liquidity.lowLiquidityPositions.forEach(tokenAddress => {
      recommendations.push({
        type: 'EXIT_POSITION',
        priority: 'HIGH',
        description: 'Low liquidity position detected',
        tokenAddress,
        suggestedAction: 'Consider exiting position due to liquidity risk',
        rationale: 'Low liquidity may prevent timely exits',
      });
    });

    return recommendations;
  }

  /**
   * Check risk thresholds and emit alerts
   */
  private async checkRiskThresholds(assessment: RiskAssessment): Promise<void> {
    const metrics = this.currentMetrics;
    if (!metrics) return;

    // Check daily loss threshold
    if (metrics.dailyPnl < -this.config.maxDailyLoss) {
      this.emitRiskAlert({
        type: 'DAILY_LOSS',
        severity: 'CRITICAL',
        message: 'Daily loss threshold exceeded',
        currentValue: Math.abs(metrics.dailyPnl),
        threshold: this.config.maxDailyLoss,
        recommendation: 'Stop trading for the day',
        timestamp: Date.now(),
      });
    }

    // Check drawdown threshold
    if (metrics.drawdown > this.config.maxDrawdown) {
      this.emitRiskAlert({
        type: 'DRAWDOWN',
        severity: 'CRITICAL',
        message: 'Maximum drawdown exceeded',
        currentValue: metrics.drawdown,
        threshold: this.config.maxDrawdown,
        recommendation: 'Emergency shutdown required',
        timestamp: Date.now(),
      });
    }

    // Check correlation risk thresholds
    if (assessment.correlationRisk.maxCorrelatedExposure > this.config.maxConcentrationRisk) {
      this.emitRiskAlert({
        type: 'CORRELATION_RISK',
        severity: 'HIGH',
        message: 'Concentration risk threshold exceeded',
        currentValue: assessment.correlationRisk.maxCorrelatedExposure,
        threshold: this.config.maxConcentrationRisk,
        recommendation: 'Diversify positions to reduce correlation risk',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Calculate risk metrics
   */
  private calculateRiskMetrics(): RiskMetrics {
    const positions = Array.from(this.positions.values());
    const trades = Array.from(this.trades.values());

    const totalValue = this.calculateTotalValue();
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
    const dailyPnl = totalValue - this.dailyStartValue;
    const drawdown = this.calculateDrawdown(totalValue);
    
    // Update max drawdown
    this.maxDrawdownSeen = Math.max(this.maxDrawdownSeen, drawdown);

    const completedTrades = trades.filter(t => t.status === 'CONFIRMED');
    const winningTrades = completedTrades.filter(t => {
      const position = positions.find(p => p.entryTradeId === t.id);
      return position && (position.pnlUsd || 0) > 0;
    });
    const winRate = completedTrades.length > 0 ? 
      (winningTrades.length / completedTrades.length) * 100 : 0;

    const positionMetrics: RiskPositionMetrics[] = positions
      .filter(p => p.status === 'OPEN')
      .map(p => ({
        tokenAddress: p.tokenAddress,
        value: p.amount * (p.entryPrice || 0),
        pnl: p.pnlUsd || 0,
        pnlPercentage: p.pnlPercent || 0,
        volatility: this.calculateTokenVolatility(p.tokenAddress),
        liquidity: 10000, // Placeholder
        riskScore: this.calculatePositionRiskScore(p),
        correlation: this.calculateAverageCorrelation(p.tokenAddress),
        holdingTime: Date.now() - p.openTimestamp,
      }));

    return {
      totalValue,
      totalPnl,
      dailyPnl,
      drawdown,
      maxDrawdown: this.maxDrawdownSeen,
      winRate,
      sharpeRatio: this.calculateSharpeRatio(trades),
      volatility: this.calculatePortfolioVolatility(),
      varDaily: this.calculateValueAtRisk(),
      positions: positionMetrics,
    };
  }

  /**
   * Helper methods for calculations
   */
  private calculateTotalExposure(): number {
    return Array.from(this.positions.values())
      .filter(p => p.status === 'OPEN')
      .reduce((sum, p) => sum + p.amount * (p.entryPrice || 0), 0);
  }

  private calculateTotalValue(): number {
    // This would typically include wallet balance + position values
    // For now, using position values only
    return this.calculateTotalExposure();
  }

  private calculateDrawdown(currentValue: number): number {
    // Calculate drawdown from peak
    if (this.dailyStartValue === 0) return 0;
    const peak = Math.max(this.dailyStartValue, currentValue);
    return peak > 0 ? ((peak - currentValue) / peak) * 100 : 0;
  }

  private calculateTokenVolatility(tokenAddress: string): number {
    const prices = this.priceHistory.get(tokenAddress) || [];
    if (prices.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance) * 100; // Convert to percentage
  }

  private getCorrelation(token1: string, token2: string): number {
    const matrix = this.correlationMatrix.get(token1);
    return matrix?.get(token2) || 0;
  }

  private updateCorrelationMatrix(): void {
    const tokens = Array.from(this.priceHistory.keys());
    
    tokens.forEach(token1 => {
      if (!this.correlationMatrix.has(token1)) {
        this.correlationMatrix.set(token1, new Map());
      }
      
      const matrix1 = this.correlationMatrix.get(token1)!;
      
      tokens.forEach(token2 => {
        if (token1 !== token2) {
          const correlation = this.calculateCorrelation(token1, token2);
          matrix1.set(token2, correlation);
        }
      });
    });
  }

  private calculateCorrelation(token1: string, token2: string): number {
    const prices1 = this.priceHistory.get(token1) || [];
    const prices2 = this.priceHistory.get(token2) || [];
    
    if (prices1.length < 10 || prices2.length < 10) return 0;

    const minLength = Math.min(prices1.length, prices2.length);
    const subset1 = prices1.slice(-minLength);
    const subset2 = prices2.slice(-minLength);

    // Simple correlation calculation
    const mean1 = subset1.reduce((sum, p) => sum + p, 0) / subset1.length;
    const mean2 = subset2.reduce((sum, p) => sum + p, 0) / subset2.length;

    let numerator = 0;
    let denominator1 = 0;
    let denominator2 = 0;

    for (let i = 0; i < minLength; i++) {
      const diff1 = subset1[i] - mean1;
      const diff2 = subset2[i] - mean2;
      
      numerator += diff1 * diff2;
      denominator1 += diff1 * diff1;
      denominator2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(denominator1 * denominator2);
    return denominator === 0 ? 0 : numerator / denominator;
  }

  private determineCorrelationRiskLevel(correlation: number, exposure: number): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (correlation > 0.8 && exposure > this.config.maxConcentrationRisk * 0.5) return 'HIGH';
    if (correlation > 0.6 && exposure > this.config.maxConcentrationRisk * 0.3) return 'MEDIUM';
    return 'LOW';
  }

  private calculatePositionRiskScore(position: Position): number {
    const volatility = this.calculateTokenVolatility(position.tokenAddress);
    const correlation = this.calculateAverageCorrelation(position.tokenAddress);
    const positionSize = position.amount * (position.entryPrice || 0);
    const sizeScore = Math.min(100, (positionSize / this.config.maxSinglePositionSize) * 100);
    
    return Math.min(100, (volatility * 0.4) + (correlation * 100 * 0.3) + (sizeScore * 0.3));
  }

  private calculateAverageCorrelation(tokenAddress: string): number {
    const matrix = this.correlationMatrix.get(tokenAddress);
    if (!matrix || matrix.size === 0) return 0;

    const correlations = Array.from(matrix.values());
    return correlations.reduce((sum, c) => sum + Math.abs(c), 0) / correlations.length;
  }

  private calculateSharpeRatio(trades: Trade[]): number {
    const completedTrades = trades.filter(t => t.status === 'CONFIRMED');
    if (completedTrades.length < 2) return 0;

    const returns = completedTrades.map(t => {
      const position = Array.from(this.positions.values()).find(p => p.entryTradeId === t.id);
      return position ? (position.pnlPercent || 0) / 100 : 0;
    });

    const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);

    return volatility === 0 ? 0 : meanReturn / volatility;
  }

  private calculatePortfolioVolatility(): number {
    const positions = Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
    if (positions.length === 0) return 0;

    const volatilities = positions.map(p => this.calculateTokenVolatility(p.tokenAddress));
    return volatilities.reduce((sum, v) => sum + v, 0) / volatilities.length;
  }

  private calculateValueAtRisk(): number {
    // Simplified VaR calculation (95% confidence)
    const portfolioValue = this.calculateTotalValue();
    const portfolioVolatility = this.calculatePortfolioVolatility() / 100;
    
    // 95% VaR = 1.65 * volatility * portfolio value
    return 1.65 * portfolioVolatility * portfolioValue;
  }

  /**
   * Emit risk alert
   */
  private emitRiskAlert(alert: RiskAlert): void {
    this.logger.warning(`Risk alert [${alert.severity}]: ${alert.message}`);
    this.emit('riskAlert', alert);
  }

  /**
   * Get current risk assessment
   */
  public getCurrentAssessment(): RiskAssessment | undefined {
    return this.currentAssessment;
  }

  /**
   * Get current risk metrics
   */
  public getCurrentMetrics(): RiskMetrics | undefined {
    return this.currentMetrics;
  }

  /**
   * Get all positions
   */
  public getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Risk management configuration updated');
    this.emit('configUpdated', this.config);
  }

  /**
   * Get status
   */
  public getStatus(): {
    isRunning: boolean;
    config: RiskConfig;
    positionCount: number;
    totalExposure: number;
    riskLevel?: string;
  } {
    return {
      isRunning: this.isRunning,
      config: this.config,
      positionCount: this.positions.size,
      totalExposure: this.calculateTotalExposure(),
      riskLevel: this.currentMetrics ? this.determineRiskLevel(
        this.getCurrentAssessment()?.riskScore || 0
      ) : undefined,
    };
  }

  /**
   * Force trigger risk assessment (for testing)
   */
  public async triggerRiskAssessment(): Promise<RiskAssessment> {
    return this.calculateRiskAssessment();
  }
}