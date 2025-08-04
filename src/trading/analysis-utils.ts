/**
 * Analysis utilities for advanced exit strategies
 * Provides functions for trend detection, volatility analysis, volume analysis, and sentiment processing
 */

import { Logger } from '../utils/logger';
import {
  PricePoint,
  VolumeData,
  VolatilityMetrics,
  TrendAnalysis,
  SentimentData,
  CreatorActivity,
} from '../types';

/**
 * Utility class for market analysis functions
 */
export class AnalysisUtils {
  private static logger = new Logger('AnalysisUtils');

  /**
   * Calculate volatility metrics from price history
   */
  static calculateVolatility(priceHistory: PricePoint[]): VolatilityMetrics {
    if (priceHistory.length < 2) {
      return {
        standardDeviation: 0,
        averagePrice: priceHistory[0]?.price || 0,
        priceRange: 0,
        volatilityPercent: 0,
        timestamp: Date.now(),
      };
    }

    const prices = priceHistory.map(p => p.price);
    const averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;

    const variance =
      prices.reduce((sum, price) => sum + Math.pow(price - averagePrice, 2), 0) / prices.length;
    const standardDeviation = Math.sqrt(variance);

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice;

    const volatilityPercent = averagePrice > 0 ? (standardDeviation / averagePrice) * 100 : 0;

    return {
      standardDeviation,
      averagePrice,
      priceRange,
      volatilityPercent,
      timestamp: Date.now(),
    };
  }

  /**
   * Analyze price trend using simple moving averages and momentum
   */
  static analyzeTrend(priceHistory: PricePoint[]): TrendAnalysis {
    if (priceHistory.length < 3) {
      return {
        direction: 'SIDEWAYS',
        strength: 0,
        confidence: 0,
        timestamp: Date.now(),
      };
    }

    // Sort by timestamp to ensure correct order
    const sortedPrices = [...priceHistory].sort((a, b) => a.timestamp - b.timestamp);
    const prices = sortedPrices.map(p => p.price);

    // Calculate short and long moving averages
    const shortPeriod = Math.min(5, Math.floor(prices.length / 2));
    const longPeriod = Math.min(10, prices.length - 1);

    const shortMA = this.calculateMovingAverage(prices, shortPeriod);
    const longMA = this.calculateMovingAverage(prices, longPeriod);

    // Calculate momentum
    const momentum = this.calculateMomentum(prices);

    // Determine trend direction
    let direction: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';
    let strength = 0;

    if (shortMA > longMA && momentum > 0) {
      direction = 'UP';
      strength = Math.min(100, Math.abs(momentum) * 10);
    } else if (shortMA < longMA && momentum < 0) {
      direction = 'DOWN';
      strength = Math.min(100, Math.abs(momentum) * 10);
    } else {
      strength = Math.max(0, 50 - Math.abs(momentum) * 20);
    }

    // Calculate confidence based on consistency
    const consistency = this.calculateTrendConsistency(prices);
    const confidence = Math.min(100, consistency * strength);

    return {
      direction,
      strength,
      confidence,
      timestamp: Date.now(),
    };
  }

  /**
   * Analyze volume patterns
   */
  static analyzeVolume(
    volumeHistory: VolumeData[],
    lookbackMinutes: number,
  ): {
    averageVolume: number;
    currentVolume: number;
    volumeChangePercent: number;
    isVolumeSpike: boolean;
    isVolumeDrop: boolean;
  } {
    if (volumeHistory.length === 0) {
      return {
        averageVolume: 0,
        currentVolume: 0,
        volumeChangePercent: 0,
        isVolumeSpike: false,
        isVolumeDrop: false,
      };
    }

    const cutoffTime = Date.now() - lookbackMinutes * 60 * 1000;
    const recentVolume = volumeHistory.filter(v => v.timestamp >= cutoffTime);

    if (recentVolume.length === 0) {
      const latestVolume = volumeHistory[volumeHistory.length - 1];
      return {
        averageVolume: latestVolume.volumeUsd,
        currentVolume: latestVolume.volumeUsd,
        volumeChangePercent: 0,
        isVolumeSpike: false,
        isVolumeDrop: false,
      };
    }

    const volumes = recentVolume.map(v => v.volumeUsd);
    const averageVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeChangePercent =
      averageVolume > 0 ? ((currentVolume - averageVolume) / averageVolume) * 100 : 0;

    // Detect spikes and drops (thresholds can be configurable)
    const spikeThreshold = 200; // 200% increase
    const dropThreshold = -50; // 50% decrease

    const isVolumeSpike = volumeChangePercent > spikeThreshold;
    const isVolumeDrop = volumeChangePercent < dropThreshold;

    return {
      averageVolume,
      currentVolume,
      volumeChangePercent,
      isVolumeSpike,
      isVolumeDrop,
    };
  }

  /**
   * Process sentiment data from multiple sources
   */
  static processSentiment(sentimentSources: SentimentData[]): SentimentData {
    if (sentimentSources.length === 0) {
      return {
        score: 0,
        confidence: 0,
        sources: [],
        timestamp: Date.now(),
      };
    }

    // Weight sentiment by confidence and recency
    let weightedScore = 0;
    let totalWeight = 0;
    const sources: string[] = [];

    sentimentSources.forEach(sentiment => {
      // Reduce weight for older data (data older than 1 hour has reduced weight)
      const ageMinutes = (Date.now() - sentiment.timestamp) / (1000 * 60);
      const ageWeight = Math.max(0.1, 1 - ageMinutes / 60);

      const weight = (sentiment.confidence / 100) * ageWeight;
      weightedScore += sentiment.score * weight;
      totalWeight += weight;
      sources.push(...sentiment.sources);
    });

    const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const averageConfidence =
      sentimentSources.reduce((sum, s) => sum + s.confidence, 0) / sentimentSources.length;

    return {
      score: finalScore,
      confidence: averageConfidence,
      sources: [...new Set(sources)],
      timestamp: Date.now(),
    };
  }

  /**
   * Detect creator selling activity
   */
  static analyzeCreatorActivity(
    activities: CreatorActivity[],
    monitoringPeriodMinutes: number,
  ): {
    totalSellPercentage: number;
    sellTransactionCount: number;
    isActivelySelln: boolean;
    largestSellPercentage: number;
    mostRecentActivity?: CreatorActivity;
  } {
    const cutoffTime = Date.now() - monitoringPeriodMinutes * 60 * 1000;
    const recentActivities = activities.filter(a => a.timestamp >= cutoffTime);
    const sellActivities = recentActivities.filter(a => a.transactionType === 'SELL');

    const totalSellPercentage = sellActivities.reduce(
      (sum, activity) => sum + activity.percentage,
      0,
    );
    const sellTransactionCount = sellActivities.length;
    const largestSellPercentage =
      sellActivities.length > 0 ? Math.max(...sellActivities.map(a => a.percentage)) : 0;

    // Consider actively selling if there are multiple sells or large single sell
    const isActivelySelln = sellTransactionCount > 1 || largestSellPercentage > 10;

    const mostRecentActivity =
      recentActivities.length > 0
        ? recentActivities.sort((a, b) => b.timestamp - a.timestamp)[0]
        : undefined;

    return {
      totalSellPercentage,
      sellTransactionCount,
      isActivelySelln,
      largestSellPercentage,
      mostRecentActivity,
    };
  }

  /**
   * Calculate simple moving average
   */
  private static calculateMovingAverage(prices: number[], period: number): number {
    if (prices.length < period) {
      return prices.reduce((sum, price) => sum + price, 0) / prices.length;
    }

    const recentPrices = prices.slice(-period);
    return recentPrices.reduce((sum, price) => sum + price, 0) / recentPrices.length;
  }

  /**
   * Calculate price momentum
   */
  private static calculateMomentum(prices: number[]): number {
    if (prices.length < 2) {
      return 0;
    }

    const firstPrice = prices[0];
    const lastPrice = prices[prices.length - 1];

    return firstPrice > 0 ? (lastPrice - firstPrice) / firstPrice : 0;
  }

  /**
   * Calculate trend consistency
   */
  private static calculateTrendConsistency(prices: number[]): number {
    if (prices.length < 3) {
      return 0;
    }

    let consistentMoves = 0;
    let totalMoves = 0;

    for (let i = 2; i < prices.length; i++) {
      const prev2 = prices[i - 2];
      const prev1 = prices[i - 1];
      const current = prices[i];

      const move1Direction = prev1 > prev2 ? 'up' : 'down';
      const move2Direction = current > prev1 ? 'up' : 'down';

      if (move1Direction === move2Direction) {
        consistentMoves++;
      }
      totalMoves++;
    }

    return totalMoves > 0 ? consistentMoves / totalMoves : 0;
  }

  /**
   * Calculate trailing stop price
   */
  static calculateTrailingStop(
    currentPrice: number,
    entryPrice: number,
    highestPrice: number,
    trailPercent: number,
    activationPercent?: number,
  ): {
    stopPrice: number;
    isActive: boolean;
    newHighest: number;
  } {
    const newHighest = Math.max(highestPrice, currentPrice);
    const gainPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

    // Check if trailing stop is activated
    const isActive = !activationPercent || gainPercent >= activationPercent;

    if (!isActive) {
      return {
        stopPrice: 0,
        isActive: false,
        newHighest,
      };
    }

    // Calculate stop price based on highest price achieved
    const stopPrice = newHighest * (1 - trailPercent / 100);

    return {
      stopPrice,
      isActive: true,
      newHighest,
    };
  }

  /**
   * Calculate volatility-adjusted stop loss
   */
  static calculateVolatilityAdjustedStop(
    currentPrice: number,
    volatilityPercent: number,
    baseStopPercent: number,
    volatilityMultiplier: number,
    minStopPercent?: number,
    maxStopPercent?: number,
  ): number {
    // Adjust stop loss based on volatility
    const volatilityAdjustment = volatilityPercent * volatilityMultiplier;
    let adjustedStopPercent = baseStopPercent + volatilityAdjustment;

    // Apply bounds
    if (minStopPercent !== undefined) {
      adjustedStopPercent = Math.max(adjustedStopPercent, minStopPercent);
    }
    if (maxStopPercent !== undefined) {
      adjustedStopPercent = Math.min(adjustedStopPercent, maxStopPercent);
    }

    return currentPrice * (1 - adjustedStopPercent / 100);
  }
}
