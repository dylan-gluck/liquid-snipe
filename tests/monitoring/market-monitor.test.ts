import { MarketMonitor, MarketConditionConfig, MarketConditionAlert } from '../../src/monitoring/market-monitor';
import { Connection } from '@solana/web3.js';

// Mock the Connection class
jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn().mockImplementation(() => ({
    getSlot: jest.fn(),
    getRecentPerformanceSamples: jest.fn(),
  })),
}));

describe('MarketMonitor', () => {
  let marketMonitor: MarketMonitor;
  let mockConnection: jest.Mocked<Connection>;
  let config: MarketConditionConfig;

  beforeEach(() => {
    // Create mock connection
    mockConnection = new Connection('http://localhost') as jest.Mocked<Connection>;
    
    // Default configuration
    config = {
      priceVolatilityThreshold: 20,
      volumeSpikeMultiplier: 3,
      liquidityDropThreshold: 25,
      monitoringInterval: 5000,
      historicalDataWindow: 30,
      enabled: true,
      circuitBreakerConfig: {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 30000,
        monitoringPeriod: 60000,
      },
    };

    marketMonitor = new MarketMonitor(mockConnection, config);
  });

  afterEach(async () => {
    await marketMonitor.stop();
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct configuration', () => {
      const status = marketMonitor.getStatus();
      expect(status.config).toEqual(config);
      expect(status.isMonitoring).toBe(false);
    });

    it('should setup circuit breakers on initialization', () => {
      const status = marketMonitor.getStatus();
      expect(status.circuitBreakerHealth).toBeDefined();
      expect(status.circuitBreakerHealth.totalBreakers).toBeGreaterThan(0);
    });
  });

  describe('monitoring lifecycle', () => {
    it('should start monitoring when enabled', async () => {
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([]);

      await marketMonitor.start();
      
      expect(marketMonitor.getStatus().isMonitoring).toBe(true);
    });

    it('should not start monitoring when disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledMonitor = new MarketMonitor(mockConnection, disabledConfig);

      await disabledMonitor.start();
      
      expect(disabledMonitor.getStatus().isMonitoring).toBe(false);
    });

    it('should stop monitoring', async () => {
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([]);

      await marketMonitor.start();
      expect(marketMonitor.getStatus().isMonitoring).toBe(true);

      await marketMonitor.stop();
      expect(marketMonitor.getStatus().isMonitoring).toBe(false);
    });

    it('should emit started event when monitoring begins', async () => {
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([]);

      const startedSpy = jest.fn();
      marketMonitor.on('started', startedSpy);

      await marketMonitor.start();
      
      expect(startedSpy).toHaveBeenCalled();
    });

    it('should emit stopped event when monitoring ends', async () => {
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([]);

      const stoppedSpy = jest.fn();
      marketMonitor.on('stopped', stoppedSpy);

      await marketMonitor.start();
      await marketMonitor.stop();
      
      expect(stoppedSpy).toHaveBeenCalled();
    });
  });

  describe('network condition monitoring', () => {
    it('should check network conditions and store metrics', async () => {
      const mockSlot = 12345;
      const mockPerformanceData = [
        {
          slot: 12340,
          numSlots: 1,
          numTransactions: 1000,
          samplePeriodSecs: 0.5,
        },
        {
          slot: 12341,
          numSlots: 1,
          numTransactions: 1200,
          samplePeriodSecs: 0.6,
        },
      ];

      mockConnection.getSlot.mockResolvedValue(mockSlot);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue(mockPerformanceData);

      await marketMonitor.triggerMonitoringCycle();

      const networkHistory = marketMonitor.getNetworkHistory();
      expect(networkHistory).toHaveLength(1);
      expect(networkHistory[0].currentSlot).toBe(mockSlot);
      expect(networkHistory[0].slotTime).toBeCloseTo(0.55); // Average of 0.5 and 0.6
      expect(networkHistory[0].transactionCount).toBeCloseTo(1100); // Average of 1000 and 1200
    });

    it('should emit network congestion alert when congestion is high', async () => {
      // Mock high congestion scenario (slow slot times)
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([
        {
          slot: 12340,
          numSlots: 1,
          numTransactions: 1000,
          samplePeriodSecs: 1.0, // Slow slot time indicating congestion
        },
      ]);

      const alertSpy = jest.fn();
      marketMonitor.on('alert', alertSpy);

      await marketMonitor.triggerMonitoringCycle();

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'NETWORK_CONGESTION',
          severity: expect.any(String),
          message: expect.stringContaining('High network congestion detected'),
        })
      );
    });
  });

  describe('price data management', () => {
    it('should store and retrieve price data', () => {
      const tokenAddress = 'test-token-address';
      const priceData = {
        price: 1.5,
        timestamp: Date.now(),
        source: 'test-source',
      };

      marketMonitor.addPriceData(tokenAddress, priceData);
      
      const history = marketMonitor.getTokenHistory(tokenAddress);
      expect(history.prices).toHaveLength(1);
      expect(history.prices[0]).toEqual(priceData);
    });

    it('should clean old price data based on historical window', () => {
      const tokenAddress = 'test-token-address';
      const oldTimestamp = Date.now() - (config.historicalDataWindow * 60 * 1000) - 1000; // Older than window
      const newTimestamp = Date.now();

      marketMonitor.addPriceData(tokenAddress, {
        price: 1.0,
        timestamp: oldTimestamp,
        source: 'test',
      });

      marketMonitor.addPriceData(tokenAddress, {
        price: 2.0,
        timestamp: newTimestamp,
        source: 'test',
      });

      // Trigger cleaning by adding more data
      marketMonitor.addPriceData(tokenAddress, {
        price: 2.5,
        timestamp: Date.now(),
        source: 'test',
      });

      const history = marketMonitor.getTokenHistory(tokenAddress);
      expect(history.prices).toHaveLength(2); // Old data should be cleaned
      expect(history.prices.every(p => p.timestamp > oldTimestamp)).toBe(true);
    });
  });

  describe('volume data management', () => {
    it('should store and retrieve volume data', () => {
      const tokenAddress = 'test-token-address';
      const volumeData = {
        volume: 1000,
        volumeUsd: 1500,
        timestamp: Date.now(),
        source: 'test-source',
      };

      marketMonitor.addVolumeData(tokenAddress, volumeData);
      
      const history = marketMonitor.getTokenHistory(tokenAddress);
      expect(history.volumes).toHaveLength(1);
      expect(history.volumes[0]).toEqual(volumeData);
    });
  });

  describe('liquidity data management', () => {
    it('should store and retrieve liquidity data', () => {
      const poolAddress = 'test-pool-address';
      const liquidityData = {
        liquidityUsd: 50000,
        timestamp: Date.now(),
        poolAddress,
      };

      marketMonitor.addLiquidityData(poolAddress, liquidityData);
      
      const history = marketMonitor.getPoolHistory(poolAddress);
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(liquidityData);
    });
  });

  describe('market metrics calculation', () => {
    beforeEach(() => {
      // Setup network conditions mocks
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([
        {
          slot: 12340,
          numSlots: 1,
          numTransactions: 1000,
          samplePeriodSecs: 0.4,
        },
      ]);
    });

    it('should calculate price volatility correctly', async () => {
      const tokenAddress = 'test-token';
      const baseTime = Date.now();

      // Add price data with varying prices
      const prices = [1.0, 1.2, 0.8, 1.5, 1.1];
      prices.forEach((price, index) => {
        marketMonitor.addPriceData(tokenAddress, {
          price,
          timestamp: baseTime - (prices.length - index) * 1000,
          source: 'test',
        });
      });

      await marketMonitor.triggerMonitoringCycle();
      
      const metrics = marketMonitor.getCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics!.priceVolatility).toBeGreaterThan(0);
    });

    it('should calculate volume changes correctly', async () => {
      const tokenAddress = 'test-token';
      const baseTime = Date.now();

      // Add volume data showing increase
      marketMonitor.addVolumeData(tokenAddress, {
        volume: 1000,
        volumeUsd: 1000,
        timestamp: baseTime - 10000,
        source: 'test',
      });

      marketMonitor.addVolumeData(tokenAddress, {
        volume: 2000,
        volumeUsd: 2000,
        timestamp: baseTime,
        source: 'test',
      });

      await marketMonitor.triggerMonitoringCycle();
      
      const metrics = marketMonitor.getCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics!.volumeChange).toBe(100); // 100% increase
    });

    it('should calculate liquidity changes correctly', async () => {
      const poolAddress = 'test-pool';
      const baseTime = Date.now();

      // Add liquidity data showing decrease
      marketMonitor.addLiquidityData(poolAddress, {
        liquidityUsd: 10000,
        timestamp: baseTime - 10000,
        poolAddress,
      });

      marketMonitor.addLiquidityData(poolAddress, {
        liquidityUsd: 7500,
        timestamp: baseTime,
        poolAddress,
      });

      await marketMonitor.triggerMonitoringCycle();
      
      const metrics = marketMonitor.getCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics!.liquidityChange).toBe(-25); // 25% decrease
    });
  });

  describe('alert generation', () => {
    beforeEach(() => {
      mockConnection.getSlot.mockResolvedValue(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValue([]);
    });

    it('should emit price volatility alert when threshold exceeded', async () => {
      const tokenAddress = 'test-token';
      const baseTime = Date.now();
      const alertSpy = jest.fn();
      marketMonitor.on('alert', alertSpy);

      // Add highly volatile price data
      const volatilePrices = [1.0, 2.0, 0.5, 3.0, 0.8]; // Very volatile
      volatilePrices.forEach((price, index) => {
        marketMonitor.addPriceData(tokenAddress, {
          price,
          timestamp: baseTime - (volatilePrices.length - index) * 1000,
          source: 'test',
        });
      });

      await marketMonitor.triggerMonitoringCycle();

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PRICE_VOLATILITY',
          severity: expect.any(String),
          message: expect.stringContaining('Unusual price volatility detected'),
        })
      );
    });

    it('should emit volume spike alert when threshold exceeded', async () => {
      const tokenAddress = 'test-token';
      const baseTime = Date.now();
      const alertSpy = jest.fn();
      marketMonitor.on('alert', alertSpy);

      // Add volume data showing massive spike
      marketMonitor.addVolumeData(tokenAddress, {
        volume: 1000,
        volumeUsd: 1000,
        timestamp: baseTime - 10000,
        source: 'test',
      });

      marketMonitor.addVolumeData(tokenAddress, {
        volume: 10000, // 10x increase (exceeds 3x threshold)
        volumeUsd: 10000,
        timestamp: baseTime,
        source: 'test',
      });

      await marketMonitor.triggerMonitoringCycle();

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'VOLUME_SPIKE',
          severity: expect.any(String),
          message: expect.stringContaining('Unusual volume change detected'),
        })
      );
    });

    it('should emit liquidity drain alert when threshold exceeded', async () => {
      const poolAddress = 'test-pool';
      const baseTime = Date.now();
      const alertSpy = jest.fn();
      marketMonitor.on('alert', alertSpy);

      // Add liquidity data showing major drain
      marketMonitor.addLiquidityData(poolAddress, {
        liquidityUsd: 10000,
        timestamp: baseTime - 10000,
        poolAddress,
      });

      marketMonitor.addLiquidityData(poolAddress, {
        liquidityUsd: 5000, // 50% drop (exceeds 25% threshold)
        timestamp: baseTime,
        poolAddress,
      });

      await marketMonitor.triggerMonitoringCycle();

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIQUIDITY_DRAIN',
          severity: expect.any(String),
          message: expect.stringContaining('Significant liquidity drain detected'),
        })
      );
    });
  });

  describe('configuration management', () => {
    it('should update configuration and emit event', () => {
      const configUpdatedSpy = jest.fn();
      marketMonitor.on('configUpdated', configUpdatedSpy);

      const newConfig = {
        priceVolatilityThreshold: 30,
        volumeSpikeMultiplier: 4,
      };

      marketMonitor.updateConfig(newConfig);

      expect(configUpdatedSpy).toHaveBeenCalledWith(
        expect.objectContaining(newConfig)
      );

      const status = marketMonitor.getStatus();
      expect(status.config.priceVolatilityThreshold).toBe(30);
      expect(status.config.volumeSpikeMultiplier).toBe(4);
    });
  });

  describe('error handling', () => {
    it('should handle RPC errors gracefully', async () => {
      mockConnection.getSlot.mockRejectedValue(new Error('RPC Error'));
      mockConnection.getRecentPerformanceSamples.mockRejectedValue(new Error('RPC Error'));

      const networkErrorSpy = jest.fn();
      marketMonitor.on('networkError', networkErrorSpy);

      await marketMonitor.triggerMonitoringCycle();

      // Should not throw, but should emit network error event
      expect(networkErrorSpy).toHaveBeenCalled();
    });

    it('should continue monitoring after errors', async () => {
      // First call fails
      mockConnection.getSlot.mockRejectedValueOnce(new Error('RPC Error'));
      mockConnection.getRecentPerformanceSamples.mockRejectedValueOnce(new Error('RPC Error'));
      
      // Second call succeeds
      mockConnection.getSlot.mockResolvedValueOnce(12345);
      mockConnection.getRecentPerformanceSamples.mockResolvedValueOnce([{
        slot: 12340,
        numSlots: 1,
        numTransactions: 1000,
        samplePeriodSecs: 0.4,
      }]);

      const cycleCompleteSpy = jest.fn();
      const networkErrorSpy = jest.fn();
      marketMonitor.on('cycleComplete', cycleCompleteSpy);
      marketMonitor.on('networkError', networkErrorSpy);

      // First cycle should fail and emit network error
      await marketMonitor.triggerMonitoringCycle();
      expect(networkErrorSpy).toHaveBeenCalled();
      expect(cycleCompleteSpy).not.toHaveBeenCalled();

      // Reset spies
      cycleCompleteSpy.mockClear();
      networkErrorSpy.mockClear();

      // Second cycle should succeed
      await marketMonitor.triggerMonitoringCycle();
      expect(cycleCompleteSpy).toHaveBeenCalled();
      expect(networkErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('status and health', () => {
    it('should provide comprehensive status information', () => {
      const status = marketMonitor.getStatus();

      expect(status).toEqual({
        isMonitoring: false,
        config: config,
        circuitBreakerHealth: expect.any(Object),
        dataPoints: {
          priceTokens: 0,
          volumeTokens: 0,
          liquidityPools: 0,
          networkSamples: 0,
        },
      });
    });

    it('should track data points correctly', () => {
      marketMonitor.addPriceData('token1', {
        price: 1.0,
        timestamp: Date.now(),
        source: 'test',
      });

      marketMonitor.addVolumeData('token2', {
        volume: 1000,
        volumeUsd: 1000,
        timestamp: Date.now(),
        source: 'test',
      });

      marketMonitor.addLiquidityData('pool1', {
        liquidityUsd: 5000,
        timestamp: Date.now(),
        poolAddress: 'pool1',
      });

      const status = marketMonitor.getStatus();
      expect(status.dataPoints.priceTokens).toBe(1);
      expect(status.dataPoints.volumeTokens).toBe(1);
      expect(status.dataPoints.liquidityPools).toBe(1);
    });
  });
});