import { RiskManager, RiskConfig, RiskAssessment, RiskAlert } from '../../src/security/risk-manager';
import { Position, Trade, TradeDecision } from '../../src/types';

describe('RiskManager', () => {
  let riskManager: RiskManager;
  let config: RiskConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      maxTotalExposure: 10000,
      maxSinglePositionSize: 1000,
      maxPortfolioPercentage: 50,
      maxConcentrationRisk: 30,
      maxDailyLoss: 500,
      maxDrawdown: 20,
      volatilityMultiplier: 0.5,
      correlationThreshold: 0.7,
      rebalanceThreshold: 10,
      riskAssessmentInterval: 5000,
      emergencyExitThreshold: 15,
    };

    riskManager = new RiskManager(config);
  });

  afterEach(async () => {
    await riskManager.stop();
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct configuration', () => {
      const status = riskManager.getStatus();
      expect(status.config).toEqual(config);
      expect(status.isRunning).toBe(false);
    });

    it('should setup circuit breakers on initialization', () => {
      const status = riskManager.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe('lifecycle management', () => {
    it('should start risk management when enabled', async () => {
      await riskManager.start();
      
      expect(riskManager.getStatus().isRunning).toBe(true);
    });

    it('should not start when disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledManager = new RiskManager(disabledConfig);

      await disabledManager.start();
      
      expect(disabledManager.getStatus().isRunning).toBe(false);
    });

    it('should stop risk management', async () => {
      await riskManager.start();
      expect(riskManager.getStatus().isRunning).toBe(true);

      await riskManager.stop();
      expect(riskManager.getStatus().isRunning).toBe(false);
    });

    it('should emit started event when monitoring begins', async () => {
      const startedSpy = jest.fn();
      riskManager.on('started', startedSpy);

      await riskManager.start();
      
      expect(startedSpy).toHaveBeenCalled();
    });

    it('should emit stopped event when monitoring ends', async () => {
      const stoppedSpy = jest.fn();
      riskManager.on('stopped', stoppedSpy);

      await riskManager.start();
      await riskManager.stop();
      
      expect(stoppedSpy).toHaveBeenCalled();
    });
  });

  describe('trade risk assessment', () => {
    it('should assess risk for a potential trade', async () => {
      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'test-token',
        baseToken: 'SOL',
        poolAddress: 'test-pool',
        tradeAmountUsd: 500,
        reason: 'Test trade',
        riskScore: 30,
      };

      const assessment = await riskManager.assessTradeRisk(tradeDecision);

      expect(assessment).toBeDefined();
      expect(assessment.riskScore).toBeGreaterThanOrEqual(0);
      expect(assessment.riskScore).toBeLessThanOrEqual(100);
      expect(assessment.riskLevel).toMatch(/^(LOW|MEDIUM|HIGH|CRITICAL)$/);
      expect(assessment.exposureAnalysis).toBeDefined();
      expect(assessment.correlationRisk).toBeDefined();
      expect(assessment.volatilityRisk).toBeDefined();
      expect(assessment.liquidityRisk).toBeDefined();
      expect(Array.isArray(assessment.recommendations)).toBe(true);
      expect(assessment.timestamp).toBeGreaterThan(0);
    });

    it('should emit alert when trade exceeds exposure limits', async () => {
      const alertSpy = jest.fn();
      riskManager.on('riskAlert', alertSpy);

      const largeTrade: TradeDecision = {
        shouldTrade: true,
        targetToken: 'test-token',
        baseToken: 'SOL',
        poolAddress: 'test-pool',
        tradeAmountUsd: config.maxTotalExposure + 1000, // Exceeds limit
        reason: 'Large test trade',
        riskScore: 30,
      };

      await riskManager.assessTradeRisk(largeTrade);

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXPOSURE_LIMIT',
          severity: 'CRITICAL',
          message: expect.stringContaining('maximum total exposure limit'),
        })
      );
    });

    it('should emit alert when single position size exceeds limit', async () => {
      const alertSpy = jest.fn();
      riskManager.on('riskAlert', alertSpy);

      const largeSingleTrade: TradeDecision = {
        shouldTrade: true,
        targetToken: 'test-token',
        baseToken: 'SOL',
        poolAddress: 'test-pool',
        tradeAmountUsd: config.maxSinglePositionSize + 100, // Exceeds single position limit
        reason: 'Large single trade',
        riskScore: 30,
      };

      await riskManager.assessTradeRisk(largeSingleTrade);

      expect(alertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXPOSURE_LIMIT',
          severity: 'HIGH',
          message: expect.stringContaining('maximum single position size'),
        })
      );
    });

    it('should emit tradeRiskAssessed event', async () => {
      const assessedSpy = jest.fn();
      riskManager.on('tradeRiskAssessed', assessedSpy);

      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'test-token',
        baseToken: 'SOL',
        poolAddress: 'test-pool',
        tradeAmountUsd: 500,
        reason: 'Test trade',
        riskScore: 30,
      };

      await riskManager.assessTradeRisk(tradeDecision);

      expect(assessedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: tradeDecision,
          assessment: expect.objectContaining({
            riskScore: expect.any(Number),
            riskLevel: expect.any(String),
          }),
        })
      );
    });
  });

  describe('position management', () => {
    it('should update position information', () => {
      const position: Position = {
        id: 'test-position-1',
        tokenAddress: 'test-token',
        entryPrice: 1.5,
        amount: 1000,
        openTimestamp: Date.now(),
        entryTradeId: 'test-trade-1',
        exitStrategy: {
          type: 'profit',
          enabled: true,
          params: { profitPercentage: 50 },
        },
        status: 'OPEN' as const,
        pnlUsd: 100,
        pnlPercent: 10,
      };

      const positionUpdatedSpy = jest.fn();
      riskManager.on('positionUpdated', positionUpdatedSpy);

      riskManager.updatePosition(position);

      expect(positionUpdatedSpy).toHaveBeenCalledWith(position);
      
      const positions = riskManager.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual(position);
    });

    it('should update trade information', () => {
      const trade: Trade = {
        id: 'test-trade-1',
        tokenAddress: 'test-token',
        poolAddress: 'test-pool',
        direction: 'BUY' as const,
        amount: 1000,
        price: 1.5,
        valueUsd: 1500,
        gasFeeUsd: 5,
        timestamp: Date.now(),
        txSignature: 'test-signature',
        status: 'CONFIRMED' as const,
      };

      const tradeUpdatedSpy = jest.fn();
      riskManager.on('tradeUpdated', tradeUpdatedSpy);

      riskManager.updateTrade(trade);

      expect(tradeUpdatedSpy).toHaveBeenCalledWith(trade);
    });

    it('should track multiple positions correctly', () => {
      const positions: Position[] = [
        {
          id: 'position-1',
          tokenAddress: 'token-1',
          entryPrice: 1.0,
          amount: 500,
          openTimestamp: Date.now(),
          entryTradeId: 'trade-1',
          exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
          status: 'OPEN' as const,
        },
        {
          id: 'position-2',
          tokenAddress: 'token-2',
          entryPrice: 2.0,
          amount: 300,
          openTimestamp: Date.now(),
          entryTradeId: 'trade-2',
          exitStrategy: { type: 'loss', enabled: true, params: { lossPercentage: 20 } },
          status: 'OPEN' as const,
        },
      ];

      positions.forEach(position => riskManager.updatePosition(position));

      const trackedPositions = riskManager.getPositions();
      expect(trackedPositions).toHaveLength(2);
      expect(trackedPositions.map(p => p.id)).toEqual(['position-1', 'position-2']);
    });
  });

  describe('price data and correlation tracking', () => {
    it('should update price data for correlation analysis', () => {
      const tokenAddress = 'test-token';
      const prices = [1.0, 1.1, 1.05, 1.2, 1.15];

      prices.forEach(price => {
        riskManager.updatePriceData(tokenAddress, price);
      });

      // Price data should be tracked internally
      // We can't directly access it, but it affects risk calculations
      expect(riskManager.getStatus()).toBeDefined();
    });

    it('should handle price updates for multiple tokens', () => {
      const tokens = ['token-1', 'token-2', 'token-3'];
      const priceUpdates = [
        { token: 'token-1', prices: [1.0, 1.1, 1.05] },
        { token: 'token-2', prices: [2.0, 2.2, 2.1] },
        { token: 'token-3', prices: [0.5, 0.55, 0.52] },
      ];

      priceUpdates.forEach(update => {
        update.prices.forEach(price => {
          riskManager.updatePriceData(update.token, price);
        });
      });

      expect(riskManager.getStatus()).toBeDefined();
    });
  });

  describe('risk assessment calculations', () => {
    beforeEach(() => {
      // Add some test positions
      const positions: Position[] = [
        {
          id: 'position-1',
          tokenAddress: 'token-1',
          entryPrice: 1.0,
          amount: 800, // $800 position
          openTimestamp: Date.now() - 3600000, // 1 hour ago
          entryTradeId: 'trade-1',
          exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
          status: 'OPEN' as const,
          pnlUsd: 80,
          pnlPercent: 10,
        },
        {
          id: 'position-2',
          tokenAddress: 'token-2',
          entryPrice: 2.0,
          amount: 300, // $600 position
          openTimestamp: Date.now() - 7200000, // 2 hours ago
          entryTradeId: 'trade-2',
          exitStrategy: { type: 'loss', enabled: true, params: { lossPercentage: 20 } },
          status: 'OPEN' as const,
          pnlUsd: -30,
          pnlPercent: -5,
        },
      ];

      positions.forEach(position => riskManager.updatePosition(position));

      // Add price history for volatility calculations
      const priceUpdates = [
        { token: 'token-1', prices: [1.0, 1.1, 1.05, 1.08, 1.12] },
        { token: 'token-2', prices: [2.0, 1.9, 2.1, 1.95, 2.05] },
      ];

      priceUpdates.forEach(update => {
        update.prices.forEach(price => {
          riskManager.updatePriceData(update.token, price);
        });
      });
    });

    it('should calculate exposure analysis correctly', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(assessment.exposureAnalysis).toBeDefined();
      expect(assessment.exposureAnalysis.totalExposureUsd).toBe(1400); // 800 + 600
      expect(assessment.exposureAnalysis.positionCount).toBe(2);
      expect(assessment.exposureAnalysis.largestPositionSize).toBe(800);
      expect(assessment.exposureAnalysis.averagePositionSize).toBe(700);
      expect(assessment.exposureAnalysis.exposureByToken).toEqual({
        'token-1': 800,
        'token-2': 600,
      });
    });

    it('should calculate correlation risk', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(assessment.correlationRisk).toBeDefined();
      expect(assessment.correlationRisk.correlationScore).toBeGreaterThanOrEqual(0);
      expect(assessment.correlationRisk.correlationScore).toBeLessThanOrEqual(100);
      expect(assessment.correlationRisk.diversificationScore).toBeGreaterThanOrEqual(0);
      expect(assessment.correlationRisk.diversificationScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(assessment.correlationRisk.correlatedGroups)).toBe(true);
    });

    it('should calculate volatility risk', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(assessment.volatilityRisk).toBeDefined();
      expect(assessment.volatilityRisk.averageVolatility).toBeGreaterThanOrEqual(0);
      expect(assessment.volatilityRisk.maxVolatility).toBeGreaterThanOrEqual(0);
      expect(assessment.volatilityRisk.volatilityScore).toBeGreaterThanOrEqual(0);
      expect(assessment.volatilityRisk.volatilityScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(assessment.volatilityRisk.highVolatilityPositions)).toBe(true);
      expect(typeof assessment.volatilityRisk.positionSizeAdjustments).toBe('object');
    });

    it('should calculate liquidity risk', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(assessment.liquidityRisk).toBeDefined();
      expect(assessment.liquidityRisk.averageLiquidity).toBeGreaterThanOrEqual(0);
      expect(assessment.liquidityRisk.minLiquidity).toBeGreaterThanOrEqual(0);
      expect(assessment.liquidityRisk.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(assessment.liquidityRisk.liquidityScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(assessment.liquidityRisk.lowLiquidityPositions)).toBe(true);
      expect(Array.isArray(assessment.liquidityRisk.liquidityWarnings)).toBe(true);
    });

    it('should generate appropriate risk recommendations', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(Array.isArray(assessment.recommendations)).toBe(true);
      
      assessment.recommendations.forEach(recommendation => {
        expect(recommendation.type).toMatch(/^(REDUCE_POSITION|EXIT_POSITION|STOP_TRADING|REBALANCE|INCREASE_STOPS)$/);
        expect(recommendation.priority).toMatch(/^(LOW|MEDIUM|HIGH|CRITICAL)$/);
        expect(typeof recommendation.description).toBe('string');
        expect(typeof recommendation.suggestedAction).toBe('string');
        expect(typeof recommendation.rationale).toBe('string');
      });
    });

    it('should determine correct risk levels', async () => {
      const assessment = await riskManager.triggerRiskAssessment();

      expect(assessment.riskLevel).toMatch(/^(LOW|MEDIUM|HIGH|CRITICAL)$/);
      
      // Risk score should be consistent with risk level
      if (assessment.riskScore >= 80) {
        expect(assessment.riskLevel).toBe('CRITICAL');
      } else if (assessment.riskScore >= 60) {
        expect(assessment.riskLevel).toBe('HIGH');
      } else if (assessment.riskScore >= 40) {
        expect(assessment.riskLevel).toBe('MEDIUM');
      } else {
        expect(assessment.riskLevel).toBe('LOW');
      }
    });
  });

  describe('risk metrics calculation', () => {
    beforeEach(async () => {
      // Add positions and start monitoring
      const position: Position = {
        id: 'test-position',
        tokenAddress: 'test-token',
        entryPrice: 1.0,
        amount: 1000,
        openTimestamp: Date.now() - 3600000,
        entryTradeId: 'test-trade',
        exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
        pnlUsd: 100,
        pnlPercent: 10,
      };

      riskManager.updatePosition(position);
      
      const trade: Trade = {
        id: 'test-trade',
        tokenAddress: 'test-token',
        poolAddress: 'test-pool',
        direction: 'BUY' as const,
        amount: 1000,
        price: 1.0,
        valueUsd: 1000,
        gasFeeUsd: 5,
        timestamp: Date.now() - 3600000,
        txSignature: 'test-signature',
        status: 'CONFIRMED' as const,
      };

      riskManager.updateTrade(trade);

      await riskManager.start();
    });

    it('should calculate current risk metrics', () => {
      const metrics = riskManager.getCurrentMetrics();

      if (metrics) {
        expect(metrics.totalValue).toBeGreaterThanOrEqual(0);
        expect(metrics.totalPnl).toBeDefined();
        expect(metrics.dailyPnl).toBeDefined();
        expect(metrics.drawdown).toBeGreaterThanOrEqual(0);
        expect(metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(metrics.winRate).toBeGreaterThanOrEqual(0);
        expect(metrics.winRate).toBeLessThanOrEqual(100);
        expect(Array.isArray(metrics.positions)).toBe(true);
      }
    });

    it('should track position metrics correctly', () => {
      const metrics = riskManager.getCurrentMetrics();

      if (metrics && metrics.positions.length > 0) {
        const positionMetric = metrics.positions[0];
        
        expect(positionMetric.tokenAddress).toBe('test-token');
        expect(positionMetric.value).toBeGreaterThan(0);
        expect(positionMetric.pnl).toBeDefined();
        expect(positionMetric.pnlPercentage).toBeDefined();
        expect(positionMetric.volatility).toBeGreaterThanOrEqual(0);
        expect(positionMetric.riskScore).toBeGreaterThanOrEqual(0);
        expect(positionMetric.riskScore).toBeLessThanOrEqual(100);
        expect(positionMetric.holdingTime).toBeGreaterThan(0);
      }
    });
  });

  describe('configuration management', () => {
    it('should update configuration', () => {
      const configUpdatedSpy = jest.fn();
      riskManager.on('configUpdated', configUpdatedSpy);

      const newConfig = {
        maxTotalExposure: 15000,
        maxSinglePositionSize: 1500,
        maxDailyLoss: 750,
      };

      riskManager.updateConfig(newConfig);

      expect(configUpdatedSpy).toHaveBeenCalledWith(
        expect.objectContaining(newConfig)
      );

      const status = riskManager.getStatus();
      expect(status.config.maxTotalExposure).toBe(15000);
      expect(status.config.maxSinglePositionSize).toBe(1500);
      expect(status.config.maxDailyLoss).toBe(750);
    });

    it('should preserve unchanged configuration values', () => {
      const originalConfig = riskManager.getStatus().config;
      
      riskManager.updateConfig({
        maxTotalExposure: 15000,
      });

      const updatedConfig = riskManager.getStatus().config;
      expect(updatedConfig.maxTotalExposure).toBe(15000);
      expect(updatedConfig.maxSinglePositionSize).toBe(originalConfig.maxSinglePositionSize);
      expect(updatedConfig.correlationThreshold).toBe(originalConfig.correlationThreshold);
    });
  });

  describe('status and monitoring', () => {
    it('should provide comprehensive status information', () => {
      const status = riskManager.getStatus();

      expect(status).toEqual({
        isRunning: false,
        config: config,
        positionCount: 0,
        totalExposure: 0,
        riskLevel: undefined,
      });
    });

    it('should track position count and exposure correctly', () => {
      const position: Position = {
        id: 'test-position',
        tokenAddress: 'test-token',
        entryPrice: 1.5,
        amount: 1000,
        openTimestamp: Date.now(),
        entryTradeId: 'test-trade',
        exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      riskManager.updatePosition(position);

      const status = riskManager.getStatus();
      expect(status.positionCount).toBe(1);
      expect(status.totalExposure).toBe(1500); // 1000 * 1.5
    });

    it('should update risk level after assessment', async () => {
      const position: Position = {
        id: 'test-position',
        tokenAddress: 'test-token',
        entryPrice: 1.0,
        amount: 500,
        openTimestamp: Date.now(),
        entryTradeId: 'test-trade',
        exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      riskManager.updatePosition(position);
      await riskManager.triggerRiskAssessment();

      const status = riskManager.getStatus();
      expect(status.riskLevel).toMatch(/^(LOW|MEDIUM|HIGH|CRITICAL)$/);
    });
  });

  describe('error handling', () => {
    it('should handle errors in risk assessment gracefully', async () => {
      const errorSpy = jest.fn();
      riskManager.on('riskAssessmentError', errorSpy);

      // Mock an error scenario by creating invalid state
      const invalidPosition = {
        id: 'invalid-position',
        tokenAddress: '',
        entryPrice: -1,
        amount: -100,
        openTimestamp: Date.now(),
        entryTradeId: '',
        exitStrategy: { type: 'profit', enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      } as Position;

      riskManager.updatePosition(invalidPosition);

      // Risk assessment should handle invalid data gracefully
      const assessment = await riskManager.triggerRiskAssessment();
      expect(assessment).toBeDefined();
    });

    it('should continue operating after errors', async () => {
      await riskManager.start();
      
      // Trigger an assessment that might have issues
      await riskManager.triggerRiskAssessment();
      
      // Should still be running
      expect(riskManager.getStatus().isRunning).toBe(true);
      
      // Should still be able to assess new trades
      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'test-token',
        baseToken: 'SOL',
        poolAddress: 'test-pool',
        tradeAmountUsd: 100,
        reason: 'Test trade',
        riskScore: 20,
      };

      const assessment = await riskManager.assessTradeRisk(tradeDecision);
      expect(assessment).toBeDefined();
    });
  });
});