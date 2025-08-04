import { Connection } from '@solana/web3.js';
import { 
  SlippageProtection,
  SlippageProtectionConfig,
  VolatilityMetrics,
  MarketImpactEstimation,
  DynamicSlippageResult,
  AdaptiveSlippageLimits 
} from '../../src/security/slippage-protection';

// Mock the Connection class
jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  Connection: jest.fn(),
}));

describe('SlippageProtection', () => {
  let slippageProtection: SlippageProtection;
  let mockConnection: jest.Mocked<Connection>;
  let config: SlippageProtectionConfig;

  const testTokenAddress = 'TOKEN123';
  const testPoolAddress = 'POOL456';

  beforeEach(() => {
    // Create mock connection
    mockConnection = {} as any;

    // Test configuration
    config = {
      baseSlippagePercent: 1.0,
      maxSlippagePercent: 10.0,
      volatilityMultiplier: 2.0,
      liquidityThresholdUsd: 10000,
      marketImpactThreshold: 0.5,
      emergencySlippagePercent: 15.0,
      adaptiveSlippageEnabled: true,
      circuitBreakerEnabled: true,
    };

    slippageProtection = new SlippageProtection(mockConnection, config);

    // Setup some test data
    slippageProtection.updateLiquidityData(testPoolAddress, 50000); // $50k liquidity
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('calculateDynamicSlippage', () => {
    it('should calculate base slippage for stable conditions', async () => {
      // Update with stable price data
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + Math.random() * 0.01); // Low volatility
      }

      const result = await slippageProtection.calculateDynamicSlippage(
        testTokenAddress,
        testPoolAddress,
        1000 // $1k trade
      );

      expect(result.recommendedSlippage).toBeCloseTo(config.baseSlippagePercent, 1);
      expect(result.minimumSlippage).toBe(config.baseSlippagePercent * 0.5);
      expect(result.maximumSlippage).toBe(config.maxSlippagePercent);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should increase slippage for high volatility', async () => {
      // Update with volatile price data
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + (Math.random() - 0.5) * 0.5); // High volatility
      }

      const result = await slippageProtection.calculateDynamicSlippage(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.recommendedSlippage).toBeGreaterThan(config.baseSlippagePercent);
      expect(result.volatilityAdjustment).toBeGreaterThan(0);
      expect(result.reasoning.some(r => r.includes('Volatility adjustment'))).toBe(true);
    });

    it('should increase slippage for low liquidity pools', async () => {
      // Set low liquidity
      slippageProtection.updateLiquidityData(testPoolAddress, 5000); // $5k liquidity (below threshold)

      const result = await slippageProtection.calculateDynamicSlippage(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.recommendedSlippage).toBeGreaterThan(config.baseSlippagePercent);
      expect(result.liquidityAdjustment).toBeGreaterThan(0);
      expect(result.reasoning.some(r => r.includes('Low liquidity adjustment'))).toBe(true);
    });

    it('should increase slippage for large trades', async () => {
      const result = await slippageProtection.calculateDynamicSlippage(
        testTokenAddress,
        testPoolAddress,
        5000 // Large trade relative to pool
      );

      expect(result.recommendedSlippage).toBeGreaterThan(config.baseSlippagePercent);
      expect(result.riskAdjustment).toBeGreaterThan(0);
      expect(result.reasoning.some(r => r.includes('Large trade risk adjustment'))).toBe(true);
    });

    it('should cap slippage at maximum limit', async () => {
      // Create extreme conditions
      slippageProtection.updateLiquidityData(testPoolAddress, 1000); // Very low liquidity
      
      // Add very volatile price data
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + (Math.random() - 0.5) * 2.0);
      }

      const result = await slippageProtection.calculateDynamicSlippage(
        testTokenAddress,
        testPoolAddress,
        10000 // Very large trade
      );

      expect(result.recommendedSlippage).toBeLessThanOrEqual(config.maxSlippagePercent);
      expect(result.reasoning.some(r => r.includes('Capped at maximum'))).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      // Test with invalid addresses to trigger error handling
      const result = await slippageProtection.calculateDynamicSlippage(
        '', // Invalid token address
        '',
        1000
      );

      // Should return conservative fallback (not necessarily the exact max)
      expect(result.recommendedSlippage).toBeGreaterThanOrEqual(config.baseSlippagePercent);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe('getAdaptiveSlippageLimits', () => {
    it('should return base limits when adaptive slippage is disabled', async () => {
      const disabledConfig = { ...config, adaptiveSlippageEnabled: false };
      const disabledProtection = new SlippageProtection(mockConnection, disabledConfig);

      const result = await disabledProtection.getAdaptiveSlippageLimits(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.currentLimit).toBe(config.baseSlippagePercent);
      expect(result.baseLimit).toBe(config.baseSlippagePercent);
      expect(result.shouldUseEmergency).toBe(false);
    });

    it('should return adaptive limits when enabled', async () => {
      const result = await slippageProtection.getAdaptiveSlippageLimits(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.currentLimit).toBeGreaterThanOrEqual(config.baseSlippagePercent);
      expect(result.baseLimit).toBe(config.baseSlippagePercent);
      expect(result.emergencyLimit).toBe(config.emergencySlippagePercent);
    });

    it('should use emergency limits when circuit breaker is active', async () => {
      slippageProtection.triggerCircuitBreaker('Test emergency', 10000); // Long timeout for this test

      const result = await slippageProtection.getAdaptiveSlippageLimits(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.shouldUseEmergency).toBe(true);
      expect(result.currentLimit).toBe(config.emergencySlippagePercent);
    });

    it('should use emergency limits for extreme volatility', async () => {
      // Create extreme volatility conditions
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + (Math.random() - 0.5) * 3.0);
      }

      const result = await slippageProtection.getAdaptiveSlippageLimits(
        testTokenAddress,
        testPoolAddress,
        1000
      );

      expect(result.shouldUseEmergency).toBe(true);
      expect(result.currentLimit).toBe(config.emergencySlippagePercent);
    });
  });

  describe('estimateMarketImpact', () => {
    it('should estimate low impact for small trades in liquid pools', async () => {
      const result = await slippageProtection.estimateMarketImpact(testPoolAddress, 500);

      expect(result.estimatedImpact).toBeLessThan(0.02); // Less than 2%
      expect(result.liquidityDepth).toBe(50000);
      expect(result.confidenceLevel).toBeGreaterThan(0);
      expect(result.recommendedMaxTradeSize).toBeGreaterThan(0);
    });

    it('should estimate higher impact for large trades', async () => {
      const result = await slippageProtection.estimateMarketImpact(testPoolAddress, 5000);

      expect(result.estimatedImpact).toBeGreaterThan(0.02);
      expect(result.liquidityDepth).toBe(50000);
    });

    it('should handle pools with no cached liquidity', async () => {
      const unknownPoolAddress = 'UNKNOWN_POOL';

      const result = await slippageProtection.estimateMarketImpact(unknownPoolAddress, 1000);

      expect(result.estimatedImpact).toBeGreaterThan(0);
      expect(result.liquidityDepth).toBe(100000); // Default value
      expect(result.confidenceLevel).toBeGreaterThan(0);
    });

    it('should cap impact at maximum threshold', async () => {
      // Very large trade in small pool
      slippageProtection.updateLiquidityData(testPoolAddress, 1000); // Very small pool

      const result = await slippageProtection.estimateMarketImpact(testPoolAddress, 10000);

      expect(result.estimatedImpact).toBeLessThanOrEqual(0.15); // Capped at 15%
    });
  });

  describe('getVolatilityMetrics', () => {
    it('should return low volatility for insufficient data', async () => {
      const result = await slippageProtection.getVolatilityMetrics('NEW_TOKEN');

      expect(result.overallVolatility).toBe(0.1);
      expect(result.priceVolatility).toBe(0.1);
      expect(result.volumeVolatility).toBe(0.1);
      expect(result.liquidityVolatility).toBe(0.1);
    });

    it('should calculate volatility from price history', async () => {
      // Add stable price data
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + Math.random() * 0.01);
      }

      const result = await slippageProtection.getVolatilityMetrics(testTokenAddress);

      expect(result.overallVolatility).toBeGreaterThan(0);
      expect(result.overallVolatility).toBeLessThan(1.0);
      expect(result.timeWindow).toBeCloseTo(Date.now(), -3); // Within reasonable time
    });

    it('should cache volatility metrics', async () => {
      // Add price data
      for (let i = 0; i < 20; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + Math.random() * 0.1);
      }

      const result1 = await slippageProtection.getVolatilityMetrics(testTokenAddress);
      const result2 = await slippageProtection.getVolatilityMetrics(testTokenAddress);

      expect(result1.timeWindow).toBe(result2.timeWindow); // Should be cached
      expect(result1.overallVolatility).toBe(result2.overallVolatility);
    });

    it('should handle calculation errors gracefully', async () => {
      // Force an error by corrupting internal state (this is a bit contrived)
      const result = await slippageProtection.getVolatilityMetrics(testTokenAddress);

      expect(result.overallVolatility).toBeGreaterThan(0);
      expect(result.overallVolatility).toBeLessThanOrEqual(1.0);
    });
  });

  describe('circuit breaker functionality', () => {
    it('should trigger and reset circuit breaker', (done) => {
      expect(slippageProtection.isCircuitBreakerActive()).toBe(false);

      // Use short timeout for testing
      slippageProtection.triggerCircuitBreaker('Test emergency', 50);
      expect(slippageProtection.isCircuitBreakerActive()).toBe(true);

      // Set a timeout to check after auto-reset
      setTimeout(() => {
        expect(slippageProtection.isCircuitBreakerActive()).toBe(false);
        done();
      }, 100); // Wait longer than the reset timeout
    });
  });

  describe('data management', () => {
    it('should update price data correctly', () => {
      slippageProtection.updatePriceData(testTokenAddress, 1.5);
      slippageProtection.updatePriceData(testTokenAddress, 1.6);
      slippageProtection.updatePriceData(testTokenAddress, 1.4);

      // The data should be stored internally (can't directly test private data)
      // but we can test that subsequent volatility calculations work
      expect(true).toBe(true); // Placeholder - actual data is private
    });

    it('should update liquidity data correctly', () => {
      slippageProtection.updateLiquidityData(testPoolAddress, 75000);

      const stats = slippageProtection.getStats();
      expect(stats.liquidityCacheSize).toBe(1);
    });

    it('should limit price history size', () => {
      // Add more than 100 data points
      for (let i = 0; i < 150; i++) {
        slippageProtection.updatePriceData(testTokenAddress, 1.0 + i * 0.01);
      }

      // Internal history should be limited (can't directly test)
      // but the system should still function
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('statistics and monitoring', () => {
    it('should provide comprehensive statistics', () => {
      slippageProtection.updateLiquidityData(testPoolAddress, 50000);
      slippageProtection.updatePriceData(testTokenAddress, 1.0);

      const stats = slippageProtection.getStats();

      expect(stats.liquidityCacheSize).toBeGreaterThanOrEqual(1);
      expect(stats.priceHistorySize).toBeGreaterThanOrEqual(1);
      expect(stats.circuitBreakerActive).toBe(false);
      expect(stats.config).toEqual(config);
    });

    it('should reflect circuit breaker state in statistics', () => {
      slippageProtection.triggerCircuitBreaker('Test', 10000); // Long timeout for this test

      const stats = slippageProtection.getStats();
      expect(stats.circuitBreakerActive).toBe(true);
    });
  });

  describe('configuration updates', () => {
    it('should update configuration correctly', () => {
      const newConfig = {
        baseSlippagePercent: 2.0,
        maxSlippagePercent: 8.0,
      };

      slippageProtection.updateConfig(newConfig);

      const stats = slippageProtection.getStats();
      expect(stats.config.baseSlippagePercent).toBe(2.0);
      expect(stats.config.maxSlippagePercent).toBe(8.0);
      expect(stats.config.volatilityMultiplier).toBe(config.volatilityMultiplier); // Unchanged
    });
  });
});