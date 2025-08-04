import CoreController from '../../src/core/controller';
import DatabaseManager from '../../src/db';
import { ConnectionManager } from '../../src/blockchain';
import { BlockchainWatcher } from '../../src/blockchain/blockchain-watcher';
import { TokenInfoService } from '../../src/blockchain/token-info-service';
import { StrategyEngine } from '../../src/trading/strategy-engine';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { PositionManager } from '../../src/trading/position-manager';
import { TuiController } from '../../src/tui';
import { EventManager } from '../../src/events/event-manager';
import { AppConfig, NewPoolEvent, TradeDecision, TradeResult } from '../../src/types';

// Mock all dependencies
jest.mock('../../src/db');
jest.mock('../../src/blockchain/connection-manager');
jest.mock('../../src/blockchain/blockchain-watcher');
jest.mock('../../src/blockchain/token-info-service');
jest.mock('../../src/trading/strategy-engine');
jest.mock('../../src/trading/trade-executor');
jest.mock('../../src/trading/position-manager');
jest.mock('../../src/tui');
jest.mock('../../src/events/event-manager');

describe('CoreController', () => {
  let controller: CoreController;
  let mockConfig: AppConfig;
  let mockDbManager: jest.Mocked<DatabaseManager>;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockEventManager: jest.Mocked<EventManager>;

  beforeEach(() => {
    // Create mock config
    mockConfig = {
      rpc: {
        httpUrl: 'http://localhost:8899',
        wsUrl: 'ws://localhost:8900',
        commitment: 'finalized',
      },
      supportedDexes: [
        {
          name: 'Raydium',
          programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          instructions: { newPoolCreation: 'initialize2' },
          enabled: true,
        },
      ],
      wallet: {
        keypairPath: './test-keypair.json',
        riskPercent: 5,
      },
      tradeConfig: {
        minLiquidityUsd: 1000,
        maxSlippagePercent: 2,
        gasLimit: 0.01,
        defaultTradeAmountUsd: 100,
      },
      exitStrategies: [],
      database: {
        path: './test.db',
      },
      dryRun: false,
      verbose: false,
      disableTui: true,
    };

    // Setup mocks
    mockDbManager = {
      initialize: jest.fn(),
      close: jest.fn(),
      addLiquidityPool: jest.fn(),
      getOpenPositions: jest.fn().mockResolvedValue([]),
    } as any;

    mockConnectionManager = {
      initialize: jest.fn(),
      shutdown: jest.fn(),
      getConnection: jest.fn(),
      on: jest.fn(),
    } as any;

    mockEventManager = {
      emit: jest.fn(),
      on: jest.fn(),
    } as any;

    // Mock constructors
    (DatabaseManager as jest.MockedClass<typeof DatabaseManager>).mockImplementation(() => mockDbManager);
    (ConnectionManager as jest.MockedClass<typeof ConnectionManager>).mockImplementation(() => mockConnectionManager);
    (EventManager as jest.MockedClass<typeof EventManager>).mockImplementation(() => mockEventManager);

    controller = new CoreController(mockConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize all components successfully', async () => {
      await controller.initialize();

      expect(mockDbManager.initialize).toHaveBeenCalled();
      expect(mockConnectionManager.initialize).toHaveBeenCalled();
      expect(mockEventManager.emit).toHaveBeenCalledWith('systemStatus', {
        status: 'STARTING',
        timestamp: expect.any(Number),
      });
      expect(mockEventManager.emit).toHaveBeenCalledWith('systemStatus', {
        status: 'READY',
        timestamp: expect.any(Number),
      });
    });

    it('should handle initialization errors gracefully', async () => {
      const error = new Error('Database initialization failed');
      mockDbManager.initialize.mockRejectedValue(error);

      await expect(controller.initialize()).rejects.toThrow(error);
      
      expect(mockEventManager.emit).toHaveBeenCalledWith('systemStatus', {
        status: 'ERROR',
        timestamp: expect.any(Number),
        reason: 'Database initialization failed',
      });
    });

    it('should not initialize TUI when disabled', async () => {
      await controller.initialize();
      expect(TuiController).not.toHaveBeenCalled();
    });

    it('should initialize TUI when enabled', async () => {
      const configWithTui = { ...mockConfig, disableTui: false };
      const controllerWithTui = new CoreController(configWithTui);
      
      await controllerWithTui.initialize();
      expect(TuiController).toHaveBeenCalled();
    });

    it('should skip blockchain watcher when no DEXes enabled', async () => {
      const configNoDeXes = {
        ...mockConfig,
        supportedDexes: [
          { ...mockConfig.supportedDexes[0], enabled: false },
        ],
      };
      const controllerNoDexes = new CoreController(configNoDeXes);
      
      await controllerNoDexes.initialize();
      expect(BlockchainWatcher).not.toHaveBeenCalled();
    });
  });

  describe('startup', () => {
    beforeEach(async () => {
      await controller.initialize();
    });

    it('should start successfully', async () => {
      const mockBlockchainWatcher = {
        start: jest.fn(),
      };
      (controller as any).blockchainWatcher = mockBlockchainWatcher;

      await controller.start();
      expect(mockBlockchainWatcher.start).toHaveBeenCalled();
    });

    it('should handle start errors gracefully', async () => {
      const mockBlockchainWatcher = {
        start: jest.fn().mockRejectedValue(new Error('Start failed')),
      };
      (controller as any).blockchainWatcher = mockBlockchainWatcher;

      await expect(controller.start()).rejects.toThrow('Start failed');
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      await controller.initialize();
    });

    it('should shutdown all components gracefully', async () => {
      const mockBlockchainWatcher = {
        stop: jest.fn(),
      };
      (controller as any).blockchainWatcher = mockBlockchainWatcher;

      await controller.shutdown();

      expect(mockBlockchainWatcher.stop).toHaveBeenCalled();
      expect(mockConnectionManager.shutdown).toHaveBeenCalled();
      expect(mockDbManager.close).toHaveBeenCalled();
      expect(mockEventManager.emit).toHaveBeenCalledWith('systemStatus', {
        status: 'SHUTDOWN',
        timestamp: expect.any(Number),
      });
    });

    it('should handle shutdown errors gracefully', async () => {
      const error = new Error('Shutdown error');
      mockConnectionManager.shutdown.mockRejectedValue(error);

      // Should not throw, just log the error
      await expect(controller.shutdown()).resolves.toBeUndefined();
    });

    it('should not shutdown twice', async () => {
      await controller.shutdown();
      await controller.shutdown(); // Second call should be ignored

      expect(mockConnectionManager.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('event handling', () => {
    let mockStrategyEngine: jest.Mocked<StrategyEngine>;
    let mockTradeExecutor: jest.Mocked<TradeExecutor>;
    let mockPositionManager: jest.Mocked<PositionManager>;

    beforeEach(async () => {
      mockStrategyEngine = {
        evaluatePool: jest.fn(),
      } as any;

      mockTradeExecutor = {
        executeTrade: jest.fn(),
      } as any;

      mockPositionManager = {
        getPosition: jest.fn(),
        evaluateExitConditions: jest.fn(),
        processExitRequest: jest.fn(),
      } as any;

      await controller.initialize();
      
      // Inject mocked components
      (controller as any).strategyEngine = mockStrategyEngine;
      (controller as any).tradeExecutor = mockTradeExecutor;
      (controller as any).positionManager = mockPositionManager;
    });

    describe('handleNewPoolEvent', () => {
      it('should handle new pool events correctly', async () => {
        const poolEvent: NewPoolEvent = {
          signature: 'test-sig',
          dex: 'Raydium',
          poolAddress: 'pool-address',
          tokenA: 'token-a',
          tokenB: 'token-b',
          timestamp: Date.now(),
        };

        const mockDecision: TradeDecision = {
          shouldTrade: true,
          targetToken: 'token-a',
          baseToken: 'token-b',
          poolAddress: 'pool-address',
          tradeAmountUsd: 100,
          reason: 'Good opportunity',
          riskScore: 5,
        };

        mockStrategyEngine.evaluatePool.mockResolvedValue(mockDecision);

        await (controller as any).handleNewPoolEvent(poolEvent);

        expect(mockDbManager.addLiquidityPool).toHaveBeenCalledWith({
          address: 'pool-address',
          dexName: 'Raydium',
          tokenA: 'token-a',
          tokenB: 'token-b',
          createdAt: poolEvent.timestamp,
          initialLiquidityUsd: 0,
          lastUpdated: poolEvent.timestamp,
          currentLiquidityUsd: 0,
        });

        expect(mockEventManager.emit).toHaveBeenCalledWith('newPool', poolEvent);
        expect(mockEventManager.emit).toHaveBeenCalledWith('tradeDecision', mockDecision);
      });

      it('should handle pool event errors gracefully', async () => {
        const poolEvent: NewPoolEvent = {
          signature: 'test-sig',
          dex: 'Raydium',
          poolAddress: 'pool-address',
          tokenA: 'token-a',
          tokenB: 'token-b',
          timestamp: Date.now(),
        };

        mockDbManager.addLiquidityPool.mockRejectedValue(new Error('DB error'));

        // Should not throw, just log the error
        await expect((controller as any).handleNewPoolEvent(poolEvent)).resolves.toBeUndefined();
      });
    });

    describe('handleTradeDecision', () => {
      it('should execute trades when decision is positive', async () => {
        const decision: TradeDecision = {
          shouldTrade: true,
          targetToken: 'token-a',
          baseToken: 'token-b',
          poolAddress: 'pool-address',
          tradeAmountUsd: 100,
          reason: 'Good opportunity',
          riskScore: 5,
        };

        const mockResult: TradeResult = {
          success: true,
          signature: 'trade-sig',
          tradeId: 'trade-id',
          positionId: 'position-id',
          timestamp: Date.now(),
        };

        mockTradeExecutor.executeTrade.mockResolvedValue(mockResult);

        await (controller as any).handleTradeDecision(decision);

        expect(mockTradeExecutor.executeTrade).toHaveBeenCalledWith(decision);
        expect(mockEventManager.emit).toHaveBeenCalledWith('tradeResult', mockResult);
      });

      it('should handle dry run mode correctly', async () => {
        const dryRunController = new CoreController({ ...mockConfig, dryRun: true });
        await dryRunController.initialize();

        const decision: TradeDecision = {
          shouldTrade: true,
          targetToken: 'token-a',
          baseToken: 'token-b',
          poolAddress: 'pool-address',
          tradeAmountUsd: 100,
          reason: 'Good opportunity',
          riskScore: 5,
        };

        await (dryRunController as any).handleTradeDecision(decision);

        expect(mockTradeExecutor.executeTrade).not.toHaveBeenCalled();
        expect(mockEventManager.emit).toHaveBeenCalledWith('tradeResult', {
          success: true,
          signature: 'DRY_RUN_SIGNATURE',
          tradeId: 'DRY_RUN_TRADE',
          positionId: 'DRY_RUN_POSITION',
          timestamp: expect.any(Number),
        });
      });

      it('should skip trades when decision is negative', async () => {
        const decision: TradeDecision = {
          shouldTrade: false,
          targetToken: 'token-a',
          baseToken: 'token-b',
          poolAddress: 'pool-address',
          tradeAmountUsd: 100,
          reason: 'Insufficient liquidity',
          riskScore: 8,
        };

        await (controller as any).handleTradeDecision(decision);

        expect(mockTradeExecutor.executeTrade).not.toHaveBeenCalled();
        expect(mockEventManager.emit).not.toHaveBeenCalledWith('tradeResult', expect.any(Object));
      });
    });

    describe('handleTradeResult', () => {
      it('should handle successful trade results', async () => {
        const result: TradeResult = {
          success: true,
          signature: 'trade-sig',
          tradeId: 'trade-id',
          positionId: 'position-id',
          timestamp: Date.now(),
        };

        await (controller as any).handleTradeResult(result);

        // Position is tracked automatically in the database, no explicit refresh needed
      });

      it('should handle failed trade results', async () => {
        const result: TradeResult = {
          success: false,
          error: 'Trade failed',
          timestamp: Date.now(),
        };

        // Should not throw, just log the error
        await expect((controller as any).handleTradeResult(result)).resolves.toBeUndefined();
      });
    });
  });

  describe('position monitoring', () => {
    let mockPositionManager: jest.Mocked<PositionManager>;

    beforeEach(async () => {
      mockPositionManager = {
        evaluateExitConditions: jest.fn(),
        exitPosition: jest.fn(),
      } as any;

      await controller.initialize();
      (controller as any).positionManager = mockPositionManager;
    });

    it('should check positions for exit conditions', async () => {
      const mockPositions = [
        { id: 'pos-1', tokenAddress: 'token-a', entryPrice: 1.0 },
        { id: 'pos-2', tokenAddress: 'token-b', entryPrice: 2.0 },
      ];

      const mockPositionModel1 = { id: 'pos-1' };
      const mockPositionModel2 = { id: 'pos-2' };

      mockDbManager.getOpenPositions.mockResolvedValue(mockPositions as any);
      
      mockPositionManager.getPosition = jest.fn()
        .mockResolvedValueOnce(mockPositionModel1 as any)
        .mockResolvedValueOnce(mockPositionModel2 as any);
      
      mockPositionManager.evaluateExitConditions = jest.fn()
        .mockReturnValueOnce({ shouldExit: false, reason: 'No exit condition', urgency: 'LOW' as const })
        .mockReturnValueOnce({ shouldExit: true, reason: 'Profit target reached', urgency: 'HIGH' as const });
        
      mockPositionManager.processExitRequest = jest.fn().mockResolvedValue(true);

      await (controller as any).checkAndExitPositions();

      expect(mockPositionManager.evaluateExitConditions).toHaveBeenCalledTimes(2);
      expect(mockPositionManager.processExitRequest).toHaveBeenCalledWith({
        positionId: 'pos-2',
        reason: 'Profit target reached',
        urgency: 'HIGH',
        partialExitPercentage: undefined,
      });
    });

    it('should handle position monitoring errors gracefully', async () => {
      mockDbManager.getOpenPositions.mockRejectedValue(new Error('DB error'));

      // Should not throw, just log the error
      await expect((controller as any).checkAndExitPositions()).resolves.toBeUndefined();
    });
  });

  describe('component access methods', () => {
    beforeEach(async () => {
      await controller.initialize();
    });

    it('should provide access to all components', () => {
      expect(controller.getConnectionManager()).toBe(mockConnectionManager);
      expect(controller.getDatabaseManager()).toBe(mockDbManager);
      expect(controller.getEventManager()).toBe(mockEventManager);
    });

    it('should return undefined for uninitialized optional components', () => {
      // Create a controller that hasn't been initialized
      const uninitializedController = new CoreController(mockConfig);
      
      expect(uninitializedController.getStrategyEngine()).toBeUndefined();
      expect(uninitializedController.getTradeExecutor()).toBeUndefined();
      expect(uninitializedController.getPositionManager()).toBeUndefined();
      expect(uninitializedController.getTokenInfoService()).toBeUndefined();
      expect(uninitializedController.getBlockchainWatcher()).toBeUndefined();
    });
  });
});