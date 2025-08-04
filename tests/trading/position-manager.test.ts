/**
 * Tests for PositionManager
 */

import { DatabaseManager } from '../../src/db';
import { EventManager } from '../../src/events/event-manager';
import {
  PositionManager,
  TokenPrice,
  TimeExitStrategy,
  ProfitExitStrategy,
  LossExitStrategy,
} from '../../src/trading/position-manager';
import { PositionModel } from '../../src/db/models/position';
import { ExitStrategyConfig } from '../../src/types';
import { Logger } from '../../src/utils/logger';

// Mock the logger to avoid console output during tests
jest.mock('../../src/utils/logger');

describe('PositionManager', () => {
  let positionManager: PositionManager;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockEventManager: jest.Mocked<EventManager>;

  // Test data
  const testTokenAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const testEntryPrice = 0.001;
  const testAmount = 1000;
  const testTradeId = 'test-trade-id';

  const mockTokenPrice: TokenPrice = {
    tokenAddress: testTokenAddress,
    price: 0.0012,
    timestamp: Date.now(),
    source: 'test',
  };

  beforeEach(() => {
    // Create mocked database
    mockDb = {
      addPosition: jest.fn().mockResolvedValue(undefined),
      getPosition: jest.fn().mockResolvedValue(null),
      getOpenPositions: jest.fn().mockResolvedValue([]),
      getClosedPositions: jest.fn().mockResolvedValue([]),
      closePosition: jest.fn().mockResolvedValue(true),
    } as any;

    // Create mocked event manager
    mockEventManager = {
      on: jest.fn(),
      emit: jest.fn().mockReturnValue(true),
      off: jest.fn(),
      once: jest.fn(),
      removeAllListeners: jest.fn(),
    } as any;

    // Create position manager with mocked dependencies
    positionManager = new PositionManager(mockDb, mockEventManager, {
      enableAutomaticExit: false, // Disable for most tests
      monitoringIntervalMs: 1000,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    test('should initialize successfully', async () => {
      await expect(positionManager.initialize()).resolves.not.toThrow();
      expect(mockEventManager.on).toHaveBeenCalledWith('tradeResult', expect.any(Function));
      expect(mockEventManager.on).toHaveBeenCalledWith('systemStatus', expect.any(Function));
    });
  });

  describe('Position Creation', () => {
    test('should create a new position', async () => {
      const exitStrategy: ExitStrategyConfig = {
        type: 'profit',
        enabled: true,
        params: { profitPercentage: 50 },
      };

      const position = await positionManager.createPosition(
        testTokenAddress,
        testEntryPrice,
        testAmount,
        testTradeId,
        exitStrategy
      );

      expect(position).toBeInstanceOf(PositionModel);
      expect(position.tokenAddress).toBe(testTokenAddress);
      expect(position.entryPrice).toBe(testEntryPrice);
      expect(position.amount).toBe(testAmount);
      expect(position.status).toBe('OPEN');
      expect(mockDb.addPosition).toHaveBeenCalledWith(position);
      expect(mockEventManager.emit).toHaveBeenCalledWith('positionUpdate', expect.any(Object));
    });
  });

  describe('Position Retrieval', () => {
    test('should get position by ID', async () => {
      const mockPosition = {
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      mockDb.getPosition.mockResolvedValue(mockPosition);

      const result = await positionManager.getPosition('test-id');
      expect(result).toBeInstanceOf(PositionModel);
      expect(result?.id).toBe('test-id');
      expect(mockDb.getPosition).toHaveBeenCalledWith('test-id');
    });

    test('should return null for non-existent position', async () => {
      mockDb.getPosition.mockResolvedValue(null);

      const result = await positionManager.getPosition('non-existent');
      expect(result).toBeNull();
    });

    test('should get open positions', async () => {
      const mockPositions = [
        {
          id: 'pos1',
          tokenAddress: testTokenAddress,
          entryPrice: testEntryPrice,
          amount: testAmount,
          openTimestamp: Date.now(),
          entryTradeId: testTradeId,
          exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
          status: 'OPEN' as const,
        },
      ];

      mockDb.getOpenPositions.mockResolvedValue(mockPositions);

      const result = await positionManager.getOpenPositions();
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(PositionModel);
      expect(mockDb.getOpenPositions).toHaveBeenCalled();
    });
  });

  describe('Price Updates', () => {
    test('should update token price', () => {
      positionManager.updateTokenPrice(mockTokenPrice);
      // No direct way to test this, but it should not throw
    });
  });

  describe('Exit Strategy Evaluation', () => {
    test('should evaluate time-based exit strategy', () => {
      const position = new PositionModel({
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now() - 61 * 60 * 1000, // 61 minutes ago
        entryTradeId: testTradeId,
        exitStrategy: {
          type: 'time',
          enabled: true,
          params: { timeMinutes: 60 },
        },
        status: 'OPEN',
      });

      const result = positionManager.evaluateExitConditions(position, mockTokenPrice);
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain('Time limit reached');
      expect(result.urgency).toBe('MEDIUM');
    });

    test('should evaluate profit-based exit strategy', () => {
      const position = new PositionModel({
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: 0.001, // Entry at $0.001
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: {
          type: 'profit',
          enabled: true,
          params: { profitPercentage: 20 }, // 20% profit target
        },
        status: 'OPEN',
      });

      // Current price gives 20% profit: (0.0012 - 0.001) / 0.001 = 0.2 = 20%
      const profitPrice: TokenPrice = {
        ...mockTokenPrice,
        price: 0.0012, // 20% above entry price of 0.001
      };

      const result = positionManager.evaluateExitConditions(position, profitPrice);
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain('Profit target reached');
      expect(result.urgency).toBe('HIGH');
    });

    test('should evaluate loss-based exit strategy', () => {
      const position = new PositionModel({
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: 0.001, // Entry at $0.001
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: {
          type: 'loss',
          enabled: true,
          params: { lossPercentage: 10 }, // 10% stop loss
        },
        status: 'OPEN',
      });

      // Current price gives 10% loss: (0.0009 - 0.001) / 0.001 = -0.1 = -10%
      const lossPrice: TokenPrice = {
        ...mockTokenPrice,
        price: 0.0009,
      };

      const result = positionManager.evaluateExitConditions(position, lossPrice);
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toContain('Stop loss triggered');
      expect(result.urgency).toBe('HIGH');
    });

    test('should not exit when conditions are not met', () => {
      const position = new PositionModel({
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now() - 30 * 60 * 1000, // 30 minutes ago
        entryTradeId: testTradeId,
        exitStrategy: {
          type: 'time',
          enabled: true,
          params: { timeMinutes: 60 }, // 60 minute target
        },
        status: 'OPEN',
      });

      const result = positionManager.evaluateExitConditions(position, mockTokenPrice);
      expect(result.shouldExit).toBe(false);
      expect(result.reason).toContain('Time remaining');
      expect(result.urgency).toBe('LOW');
    });
  });

  describe('Exit Request Processing', () => {
    test('should process exit request for valid position', async () => {
      const mockPosition = {
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      mockDb.getPosition.mockResolvedValue(mockPosition);

      const exitRequest = {
        positionId: 'test-id',
        reason: 'Manual exit',
        targetPrice: 0.0015,
        urgency: 'MEDIUM' as const,
      };

      const result = await positionManager.processExitRequest(exitRequest);
      expect(result).toBe(true);
      expect(mockEventManager.emit).toHaveBeenCalledWith('tradeDecision', expect.any(Object));
    });

    test('should reject exit request for non-existent position', async () => {
      mockDb.getPosition.mockResolvedValue(null);

      const exitRequest = {
        positionId: 'non-existent',
        reason: 'Manual exit',
        urgency: 'MEDIUM' as const,
      };

      const result = await positionManager.processExitRequest(exitRequest);
      expect(result).toBe(false);
    });

    test('should reject duplicate exit requests', async () => {
      const mockPosition = {
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      mockDb.getPosition.mockResolvedValue(mockPosition);

      const exitRequest = {
        positionId: 'test-id',
        reason: 'Manual exit',
        urgency: 'MEDIUM' as const,
      };

      // First request should succeed
      const result1 = await positionManager.processExitRequest(exitRequest);
      expect(result1).toBe(true);

      // Second request should fail (duplicate)
      const result2 = await positionManager.processExitRequest(exitRequest);
      expect(result2).toBe(false);
    });
  });

  describe('Position Closing', () => {
    test('should close position successfully', async () => {
      const mockPosition = {
        id: 'test-id',
        tokenAddress: testTokenAddress,
        entryPrice: testEntryPrice,
        amount: testAmount,
        openTimestamp: Date.now(),
        entryTradeId: testTradeId,
        exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
        status: 'OPEN' as const,
      };

      mockDb.getPosition.mockResolvedValue(mockPosition);
      mockDb.closePosition.mockResolvedValue(true);

      const exitPrice = 0.0015;
      const result = await positionManager.closePosition('test-id', 'exit-trade-id', exitPrice);

      expect(result).toBe(true);
      expect(mockDb.closePosition).toHaveBeenCalledWith(
        'test-id',
        'exit-trade-id',
        expect.any(Number),
        expect.any(Number),
        expect.any(Number)
      );
      expect(mockEventManager.emit).toHaveBeenCalledWith('positionUpdate', expect.any(Object));
    });

    test('should fail to close non-existent position', async () => {
      mockDb.getPosition.mockResolvedValue(null);

      const result = await positionManager.closePosition('non-existent', 'exit-trade-id', 0.0015);
      expect(result).toBe(false);
      expect(mockDb.closePosition).not.toHaveBeenCalled();
    });
  });

  describe('Statistics', () => {
    test('should calculate position statistics', async () => {
      const openPositions = [
        {
          id: 'open1',
          tokenAddress: testTokenAddress,
          entryPrice: 0.001,
          amount: 1000,
          openTimestamp: Date.now() - 30 * 60 * 1000,
          entryTradeId: 'trade1',
          exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
          status: 'OPEN' as const,
        },
      ];

      const closedPositions = [
        {
          id: 'closed1',
          tokenAddress: testTokenAddress,
          entryPrice: 0.001,
          amount: 1000,
          openTimestamp: Date.now() - 120 * 60 * 1000,
          closeTimestamp: Date.now() - 60 * 60 * 1000,
          entryTradeId: 'trade2',
          exitTradeId: 'trade3',
          exitStrategy: { type: 'profit' as const, enabled: true, params: { profitPercentage: 50 } },
          status: 'CLOSED' as const,
          pnlUsd: 100,
          pnlPercent: 25,
        },
        {
          id: 'closed2',
          tokenAddress: testTokenAddress,
          entryPrice: 0.001,
          amount: 1000,
          openTimestamp: Date.now() - 180 * 60 * 1000,
          closeTimestamp: Date.now() - 120 * 60 * 1000,
          entryTradeId: 'trade4',
          exitTradeId: 'trade5',
          exitStrategy: { type: 'loss' as const, enabled: true, params: { lossPercentage: 10 } },
          status: 'CLOSED' as const,
          pnlUsd: -50,
          pnlPercent: -15,
        },
      ];

      mockDb.getOpenPositions.mockResolvedValue(openPositions);
      mockDb.getClosedPositions.mockResolvedValue(closedPositions);

      const stats = await positionManager.getStats();

      expect(stats.totalPositions).toBe(3);
      expect(stats.openPositions).toBe(1);
      expect(stats.closedPositions).toBe(2);
      expect(stats.totalPnlUsd).toBe(50); // 100 + (-50)
      expect(stats.totalPnlPercent).toBe((25 + (-15)) / 3); // Average P&L%
      expect(stats.successRate).toBe(50); // 1 out of 2 closed positions profitable
      expect(stats.strategiesUsed.profit).toBe(2);
      expect(stats.strategiesUsed.loss).toBe(1);
    });
  });

  describe('Exit Strategies', () => {
    describe('TimeExitStrategy', () => {
      test('should create strategy with correct configuration', () => {
        const config: ExitStrategyConfig = {
          type: 'time',
          enabled: true,
          params: { timeMinutes: 60 },
        };

        const strategy = new TimeExitStrategy(config);
        expect(strategy.type).toBe('time');
        expect(strategy.getDescription()).toBe('Exit after 60 minutes');
      });
    });

    describe('ProfitExitStrategy', () => {
      test('should create strategy with correct configuration', () => {
        const config: ExitStrategyConfig = {
          type: 'profit',
          enabled: true,
          params: { profitPercentage: 25 },
        };

        const strategy = new ProfitExitStrategy(config);
        expect(strategy.type).toBe('profit');
        expect(strategy.getDescription()).toBe('Exit at 25% profit');
      });
    });

    describe('LossExitStrategy', () => {
      test('should create strategy with correct configuration', () => {
        const config: ExitStrategyConfig = {
          type: 'loss',
          enabled: true,
          params: { lossPercentage: 15 },
        };

        const strategy = new LossExitStrategy(config);
        expect(strategy.type).toBe('loss');
        expect(strategy.getDescription()).toBe('Stop loss at 15%');
      });
    });
  });

  describe('Shutdown', () => {
    test('should shutdown gracefully', async () => {
      await expect(positionManager.shutdown()).resolves.not.toThrow();
    });

    test('should handle shutdown with pending exits', async () => {
      // This test simply verifies that shutdown completes without throwing
      // The actual pending exit handling is tested separately
      await expect(positionManager.shutdown()).resolves.not.toThrow();
    });
  });
});