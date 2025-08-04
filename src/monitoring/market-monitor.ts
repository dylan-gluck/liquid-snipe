import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';
import { CircuitBreaker, CircuitBreakerRegistry } from '../core/circuit-breaker';
import { Connection, PublicKey } from '@solana/web3.js';

export interface MarketConditionConfig {
  priceVolatilityThreshold: number; // Percentage threshold for unusual price volatility
  volumeSpikeMultiplier: number; // Multiplier for unusual volume spikes
  liquidityDropThreshold: number; // Percentage drop in liquidity to trigger alert
  monitoringInterval: number; // Milliseconds between checks
  historicalDataWindow: number; // Minutes of historical data to consider
  enabled: boolean;
  circuitBreakerConfig: {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
    monitoringPeriod: number;
  };
}

export interface MarketConditionAlert {
  type: 'PRICE_VOLATILITY' | 'VOLUME_SPIKE' | 'LIQUIDITY_DRAIN' | 'NETWORK_CONGESTION' | 'ORACLE_DEVIATION';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  data: Record<string, any>;
  timestamp: number;
  poolAddress?: string;
  tokenAddress?: string;
}

export interface MarketMetrics {
  priceVolatility: number;
  volumeChange: number;
  liquidityChange: number;
  networkCongestion: number;
  averageSlot: number;
  timestamp: number;
}

export interface PriceData {
  price: number;
  timestamp: number;
  source: string;
}

export interface VolumeData {
  volume: number;
  volumeUsd: number;
  timestamp: number;
  source: string;
}

export interface LiquidityData {
  liquidityUsd: number;
  timestamp: number;
  poolAddress: string;
}

export interface NetworkMetrics {
  currentSlot: number;
  slotTime: number;
  transactionCount: number;
  avgTxFee: number;
  congestionLevel: number;
  timestamp: number;
}

/**
 * Market condition monitoring system for detecting unusual market behavior
 * and potential risks that could affect trading operations
 */
export class MarketMonitor extends EventEmitter {
  private logger: Logger;
  private config: MarketConditionConfig;
  private connection: Connection;
  private circuitBreakerRegistry: CircuitBreakerRegistry;
  private monitoringInterval?: NodeJS.Timeout;
  private isMonitoring = false;

  // Historical data storage
  private priceHistory = new Map<string, PriceData[]>();
  private volumeHistory = new Map<string, VolumeData[]>();
  private liquidityHistory = new Map<string, LiquidityData[]>();
  private networkHistory: NetworkMetrics[] = [];

  // Cache for performance
  private lastMetrics?: MarketMetrics;
  private lastNetworkCheck = 0;

  constructor(connection: Connection, config: MarketConditionConfig) {
    super();
    this.connection = connection;
    this.config = config;
    this.logger = new Logger('MarketMonitor');
    this.circuitBreakerRegistry = new CircuitBreakerRegistry();

    this.setupCircuitBreakers();
  }

  /**
   * Setup circuit breakers for monitoring operations
   */
  private setupCircuitBreakers(): void {
    // Circuit breaker for RPC calls
    this.circuitBreakerRegistry.getOrCreate('rpc-calls', {
      ...this.config.circuitBreakerConfig,
      name: 'rpc-calls',
    });

    // Circuit breaker for price data fetching
    this.circuitBreakerRegistry.getOrCreate('price-data', {
      ...this.config.circuitBreakerConfig,
      name: 'price-data',
    });
  }

  /**
   * Start monitoring market conditions
   */
  public async start(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warning('Market monitor is already running');
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('Market monitoring is disabled');
      return;
    }

    this.logger.info('Starting market condition monitoring');
    this.isMonitoring = true;

    // Start monitoring loop
    this.monitoringInterval = setInterval(
      () => this.performMonitoringCycle(),
      this.config.monitoringInterval
    );

    // Perform initial check
    await this.performMonitoringCycle();

    this.emit('started');
  }

  /**
   * Stop monitoring market conditions
   */
  public async stop(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    this.logger.info('Stopping market condition monitoring');
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.emit('stopped');
  }

  /**
   * Perform a single monitoring cycle
   */
  private async performMonitoringCycle(): Promise<void> {
    let hasErrors = false;
    
    try {
      // Check network conditions
      await this.checkNetworkConditions();
    } catch (error) {
      this.logger.error('Network condition check failed:', error as Record<string, any>);
      this.emit('networkError', error);
      hasErrors = true;
    }

    try {
      // Analyze market metrics (only if we have some data)
      const metrics = await this.calculateMarketMetrics();
      this.lastMetrics = metrics;

      // Check for unusual conditions
      await this.analyzeMarketConditions(metrics);

      // Clean old data
      this.cleanOldData();

      // Only emit cycle complete if no critical errors occurred
      if (!hasErrors) {
        this.emit('cycleComplete', metrics);
      }
    } catch (error) {
      this.logger.error('Error in monitoring cycle:', error as Record<string, any>);
      this.emit('monitoringError', error);
    }
  }

  /**
   * Check network congestion and performance metrics
   */
  private async checkNetworkConditions(): Promise<void> {
    const now = Date.now();
    
    // Skip if checked recently (cache for 30 seconds)
    if (now - this.lastNetworkCheck < 30000) {
      return;
    }

    const circuitBreaker = this.circuitBreakerRegistry.get('rpc-calls')!;

    try {
      const networkMetrics = await circuitBreaker.execute(async () => {
        const [slotInfo, recentPerformance] = await Promise.all([
          this.connection.getSlot('confirmed'),
          this.connection.getRecentPerformanceSamples(5),
        ]);

        const avgSlotTime = recentPerformance.length > 0
          ? recentPerformance.reduce((sum, sample) => sum + sample.samplePeriodSecs, 0) / recentPerformance.length
          : 0.4; // Default Solana slot time

        const avgTxCount = recentPerformance.length > 0
          ? recentPerformance.reduce((sum, sample) => sum + sample.numTransactions, 0) / recentPerformance.length
          : 0;

        // Estimate congestion level based on slot time deviation
        const expectedSlotTime = 0.4; // 400ms expected
        const congestionLevel = Math.max(0, Math.min(100, ((avgSlotTime - expectedSlotTime) / expectedSlotTime) * 100));

        return {
          currentSlot: slotInfo,
          slotTime: avgSlotTime,
          transactionCount: avgTxCount,
          avgTxFee: 0, // Would need to calculate from recent transactions
          congestionLevel,
          timestamp: now,
        };
      });

      this.networkHistory.push(networkMetrics);
      this.lastNetworkCheck = now;

      // Check for network congestion alerts
      if (networkMetrics.congestionLevel > 50) {
        this.emitAlert({
          type: 'NETWORK_CONGESTION',
          severity: networkMetrics.congestionLevel > 80 ? 'CRITICAL' : 'HIGH',
          message: `High network congestion detected: ${networkMetrics.congestionLevel.toFixed(1)}%`,
          data: networkMetrics,
          timestamp: now,
        });
      }

    } catch (error) {
      // Re-throw to be handled by monitoring cycle
      throw error;
    }
  }

  /**
   * Calculate current market metrics
   */
  private async calculateMarketMetrics(): Promise<MarketMetrics> {
    const now = Date.now();
    const windowMs = this.config.historicalDataWindow * 60 * 1000;

    // Calculate price volatility across all monitored tokens
    let totalVolatility = 0;
    let tokenCount = 0;

    for (const [tokenAddress, priceData] of this.priceHistory) {
      const recentData = priceData.filter(p => now - p.timestamp <= windowMs);
      if (recentData.length >= 2) {
        const volatility = this.calculateVolatility(recentData.map(p => p.price));
        totalVolatility += volatility;
        tokenCount++;
      }
    }

    const averageVolatility = tokenCount > 0 ? totalVolatility / tokenCount : 0;

    // Calculate volume changes
    let totalVolumeChange = 0;
    let volumeTokenCount = 0;

    for (const [tokenAddress, volumeData] of this.volumeHistory) {
      const recentData = volumeData.filter(v => now - v.timestamp <= windowMs);
      if (recentData.length >= 2) {
        const oldVolume = recentData[0].volumeUsd;
        const newVolume = recentData[recentData.length - 1].volumeUsd;
        const change = oldVolume > 0 ? ((newVolume - oldVolume) / oldVolume) * 100 : 0;
        totalVolumeChange += change;
        volumeTokenCount++;
      }
    }

    const averageVolumeChange = volumeTokenCount > 0 ? totalVolumeChange / volumeTokenCount : 0;

    // Calculate liquidity changes
    let totalLiquidityChange = 0;
    let liquidityPoolCount = 0;

    for (const [poolAddress, liquidityData] of this.liquidityHistory) {
      const recentData = liquidityData.filter(l => now - l.timestamp <= windowMs);
      if (recentData.length >= 2) {
        const oldLiquidity = recentData[0].liquidityUsd;
        const newLiquidity = recentData[recentData.length - 1].liquidityUsd;
        const change = oldLiquidity > 0 ? ((newLiquidity - oldLiquidity) / oldLiquidity) * 100 : 0;
        totalLiquidityChange += change;
        liquidityPoolCount++;
      }
    }

    const averageLiquidityChange = liquidityPoolCount > 0 ? totalLiquidityChange / liquidityPoolCount : 0;

    // Get network congestion from recent network metrics
    const recentNetworkData = this.networkHistory.filter(n => now - n.timestamp <= windowMs);
    const averageNetworkCongestion = recentNetworkData.length > 0
      ? recentNetworkData.reduce((sum, n) => sum + n.congestionLevel, 0) / recentNetworkData.length
      : 0;

    const averageSlot = recentNetworkData.length > 0
      ? recentNetworkData.reduce((sum, n) => sum + n.currentSlot, 0) / recentNetworkData.length
      : 0;

    return {
      priceVolatility: averageVolatility,
      volumeChange: averageVolumeChange,
      liquidityChange: averageLiquidityChange,
      networkCongestion: averageNetworkCongestion,
      averageSlot,
      timestamp: now,
    };
  }

  /**
   * Analyze market conditions for unusual patterns
   */
  private async analyzeMarketConditions(metrics: MarketMetrics): Promise<void> {
    // Check price volatility
    if (metrics.priceVolatility > this.config.priceVolatilityThreshold) {
      this.emitAlert({
        type: 'PRICE_VOLATILITY',
        severity: metrics.priceVolatility > this.config.priceVolatilityThreshold * 2 ? 'CRITICAL' : 'HIGH',
        message: `Unusual price volatility detected: ${metrics.priceVolatility.toFixed(2)}%`,
        data: { volatility: metrics.priceVolatility, threshold: this.config.priceVolatilityThreshold },
        timestamp: metrics.timestamp,
      });
    }

    // Check volume spikes
    if (Math.abs(metrics.volumeChange) > this.config.volumeSpikeMultiplier * 100) {
      this.emitAlert({
        type: 'VOLUME_SPIKE',
        severity: Math.abs(metrics.volumeChange) > this.config.volumeSpikeMultiplier * 200 ? 'CRITICAL' : 'HIGH',
        message: `Unusual volume change detected: ${metrics.volumeChange.toFixed(2)}%`,
        data: { volumeChange: metrics.volumeChange, threshold: this.config.volumeSpikeMultiplier * 100 },
        timestamp: metrics.timestamp,
      });
    }

    // Check liquidity drains
    if (metrics.liquidityChange < -this.config.liquidityDropThreshold) {
      this.emitAlert({
        type: 'LIQUIDITY_DRAIN',
        severity: metrics.liquidityChange < -this.config.liquidityDropThreshold * 2 ? 'CRITICAL' : 'HIGH',
        message: `Significant liquidity drain detected: ${metrics.liquidityChange.toFixed(2)}%`,
        data: { liquidityChange: metrics.liquidityChange, threshold: -this.config.liquidityDropThreshold },
        timestamp: metrics.timestamp,
      });
    }
  }

  /**
   * Calculate price volatility (standard deviation)
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    return (stdDev / mean) * 100; // Return as percentage
  }

  /**
   * Add price data for monitoring
   */
  public addPriceData(tokenAddress: string, priceData: PriceData): void {
    if (!this.priceHistory.has(tokenAddress)) {
      this.priceHistory.set(tokenAddress, []);
    }

    const history = this.priceHistory.get(tokenAddress)!;
    history.push(priceData);

    // Keep only recent data
    const windowMs = this.config.historicalDataWindow * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    this.priceHistory.set(tokenAddress, history.filter(p => p.timestamp > cutoff));
  }

  /**
   * Add volume data for monitoring
   */
  public addVolumeData(tokenAddress: string, volumeData: VolumeData): void {
    if (!this.volumeHistory.has(tokenAddress)) {
      this.volumeHistory.set(tokenAddress, []);
    }

    const history = this.volumeHistory.get(tokenAddress)!;
    history.push(volumeData);

    // Keep only recent data
    const windowMs = this.config.historicalDataWindow * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    this.volumeHistory.set(tokenAddress, history.filter(v => v.timestamp > cutoff));
  }

  /**
   * Add liquidity data for monitoring
   */
  public addLiquidityData(poolAddress: string, liquidityData: LiquidityData): void {
    if (!this.liquidityHistory.has(poolAddress)) {
      this.liquidityHistory.set(poolAddress, []);
    }

    const history = this.liquidityHistory.get(poolAddress)!;
    history.push(liquidityData);

    // Keep only recent data
    const windowMs = this.config.historicalDataWindow * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    this.liquidityHistory.set(poolAddress, history.filter(l => l.timestamp > cutoff));
  }

  /**
   * Clean old data to prevent memory leaks
   */
  private cleanOldData(): void {
    const cutoff = Date.now() - (this.config.historicalDataWindow * 60 * 1000);

    // Clean price history
    for (const [tokenAddress, history] of this.priceHistory) {
      const filtered = history.filter(p => p.timestamp > cutoff);
      if (filtered.length === 0) {
        this.priceHistory.delete(tokenAddress);
      } else {
        this.priceHistory.set(tokenAddress, filtered);
      }
    }

    // Clean volume history
    for (const [tokenAddress, history] of this.volumeHistory) {
      const filtered = history.filter(v => v.timestamp > cutoff);
      if (filtered.length === 0) {
        this.volumeHistory.delete(tokenAddress);
      } else {
        this.volumeHistory.set(tokenAddress, filtered);
      }
    }

    // Clean liquidity history
    for (const [poolAddress, history] of this.liquidityHistory) {
      const filtered = history.filter(l => l.timestamp > cutoff);
      if (filtered.length === 0) {
        this.liquidityHistory.delete(poolAddress);
      } else {
        this.liquidityHistory.set(poolAddress, filtered);
      }
    }

    // Clean network history
    this.networkHistory = this.networkHistory.filter(n => n.timestamp > cutoff);
  }

  /**
   * Emit a market condition alert
   */
  private emitAlert(alert: MarketConditionAlert): void {
    this.logger.warning(`Market alert [${alert.severity}]: ${alert.message}`);
    this.emit('alert', alert);
  }

  /**
   * Get current market metrics
   */
  public getCurrentMetrics(): MarketMetrics | undefined {
    return this.lastMetrics;
  }

  /**
   * Get historical data for a specific token
   */
  public getTokenHistory(tokenAddress: string): {
    prices: PriceData[];
    volumes: VolumeData[];
  } {
    return {
      prices: this.priceHistory.get(tokenAddress) || [],
      volumes: this.volumeHistory.get(tokenAddress) || [],
    };
  }

  /**
   * Get historical data for a specific pool
   */
  public getPoolHistory(poolAddress: string): LiquidityData[] {
    return this.liquidityHistory.get(poolAddress) || [];
  }

  /**
   * Get network performance history
   */
  public getNetworkHistory(): NetworkMetrics[] {
    return [...this.networkHistory];
  }

  /**
   * Update monitoring configuration
   */
  public updateConfig(newConfig: Partial<MarketConditionConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Market monitoring configuration updated');
    this.emit('configUpdated', this.config);
  }

  /**
   * Get monitoring status
   */
  public getStatus(): {
    isMonitoring: boolean;
    config: MarketConditionConfig;
    circuitBreakerHealth: any;
    dataPoints: {
      priceTokens: number;
      volumeTokens: number;
      liquidityPools: number;
      networkSamples: number;
    };
  } {
    return {
      isMonitoring: this.isMonitoring,
      config: this.config,
      circuitBreakerHealth: this.circuitBreakerRegistry.getOverallHealth(),
      dataPoints: {
        priceTokens: this.priceHistory.size,
        volumeTokens: this.volumeHistory.size,
        liquidityPools: this.liquidityHistory.size,
        networkSamples: this.networkHistory.length,
      },
    };
  }

  /**
   * Force trigger a monitoring cycle (for testing)
   */
  public async triggerMonitoringCycle(): Promise<void> {
    await this.performMonitoringCycle();
  }
}