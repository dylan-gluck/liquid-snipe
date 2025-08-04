import { TuiController } from '../../src/tui';
import { DatabaseManager } from '../../src/db';
import { EventManager } from '../../src/events/event-manager';
import { AppConfig } from '../../src/types';
import path from 'path';

// Mock blessed to avoid terminal dependencies in tests
jest.mock('blessed', () => ({
  screen: jest.fn(() => ({
    render: jest.fn(),
    append: jest.fn(),
    key: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
  })),
  box: jest.fn(() => ({
    on: jest.fn(),
    setContent: jest.fn(),
    setLabel: jest.fn(),
    append: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    screen: null,
  })),
  listtable: jest.fn(() => ({
    setData: jest.fn(),
    on: jest.fn(),
    key: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    selected: 0,
    screen: null,
  })),
  textbox: jest.fn(() => ({
    on: jest.fn(),
    key: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    setValue: jest.fn(),
    getValue: jest.fn(() => ''),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    screen: null,
  })),
  log: jest.fn(() => ({
    log: jest.fn(),
    setContent: jest.fn(),
    key: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    scroll: jest.fn(),
    setScrollPerc: jest.fn(),
    alwaysScroll: true,
    screen: null,
  })),
  message: jest.fn(() => ({
    focus: jest.fn(),
    key: jest.fn(),
    destroy: jest.fn(),
    setContent: jest.fn(),
  })),
}));

describe('TuiController', () => {
  let tuiController: TuiController;
  let dbManager: DatabaseManager;
  let eventManager: EventManager;
  let mockConfig: AppConfig;

  beforeEach(async () => {
    // Create test database
    const testDbPath = path.join(__dirname, '..', 'test-data', 'test-tui.db');
    
    // Create mock config
    mockConfig = {
      rpc: {
        httpUrl: 'http://localhost:8899',
        wsUrl: 'ws://localhost:8900',
      },
      supportedDexes: [
        {
          name: 'TestDEX',
          programId: 'TestProgramId',
          instructions: { newPoolCreation: 'initialize' },
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
      exitStrategies: [
        {
          type: 'profit',
          enabled: true,
          params: { profitPercentage: 50 },
        },
      ],
      database: {
        path: testDbPath,
      },
      dryRun: false,
      verbose: false,
      disableTui: false,
    };

    // Initialize database and event manager
    dbManager = new DatabaseManager(testDbPath);
    await dbManager.initialize();

    eventManager = new EventManager(dbManager, { persistEvents: false });

    // Create TUI controller
    tuiController = new TuiController(mockConfig, dbManager, eventManager);
  });

  afterEach(async () => {
    // Clean up
    if (tuiController) {
      tuiController.stop();
    }
    if (dbManager) {
      await dbManager.close();
    }
  });

  describe('Initialization', () => {
    test('should initialize with correct configuration', () => {
      expect(tuiController).toBeDefined();
    });

    test('should be in stopped state initially', () => {
      expect(tuiController.isRunning()).toBe(false);
    });
  });

  describe('Lifecycle Management', () => {
    test('should start successfully', () => {
      expect(() => {
        tuiController.start();
      }).not.toThrow();
      
      expect(tuiController.isRunning()).toBe(true);
    });

    test('should stop successfully', () => {
      tuiController.start();
      expect(tuiController.isRunning()).toBe(true);
      
      tuiController.stop();
      expect(tuiController.isRunning()).toBe(false);
    });

    test('should handle multiple starts/stops', () => {
      tuiController.start();
      tuiController.start(); // Should not throw
      expect(tuiController.isRunning()).toBe(true);
      
      tuiController.stop();
      tuiController.stop(); // Should not throw
      expect(tuiController.isRunning()).toBe(false);
    });
  });

  describe('Component Integration', () => {
    beforeEach(() => {
      tuiController.start();
    });

    test('should handle command execution', async () => {
      // This would test the command handling
      // In a real implementation, we'd need to access private methods or add public testing methods
      expect(tuiController.isRunning()).toBe(true);
    });

    test('should handle event updates', async () => {
      // Emit a test event and verify UI updates
      eventManager.emit('systemStatus', {
        status: 'READY',
        timestamp: Date.now(),
      });

      // In a real test, we'd verify the UI was updated
      expect(tuiController.isRunning()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle database errors gracefully', async () => {
      tuiController.start();
      
      // Close database to simulate error
      await dbManager.close();
      
      // TUI should still be running even if database operations fail
      expect(tuiController.isRunning()).toBe(true);
    });

    test('should handle invalid commands gracefully', async () => {
      tuiController.start();
      
      // This would test command error handling
      expect(tuiController.isRunning()).toBe(true);
    });
  });

  describe('Memory Management', () => {
    test('should clean up resources on stop', () => {
      tuiController.start();
      
      // Add some data to components
      eventManager.emit('newPool', {
        signature: 'test-signature',
        dex: 'TestDEX',
        poolAddress: 'test-pool-address',
        tokenA: 'token-a',
        tokenB: 'token-b',
        timestamp: Date.now(),
      });

      tuiController.stop();
      
      // Verify cleanup occurred
      expect(tuiController.isRunning()).toBe(false);
    });
  });
});

describe('TUI Component Integration', () => {
  let dbManager: DatabaseManager;
  let eventManager: EventManager;

  beforeEach(async () => {
    const testDbPath = path.join(__dirname, '..', 'test-data', 'test-integration.db');
    dbManager = new DatabaseManager(testDbPath);
    await dbManager.initialize();
    eventManager = new EventManager(dbManager, { persistEvents: false });
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.close();
    }
  });

  test('should handle end-to-end pool detection workflow', async () => {
    // Add test data to database
    await dbManager.addToken({
      address: 'token-a-address',
      symbol: 'TESTA',
      name: 'Test Token A',
      decimals: 9,
      firstSeen: Date.now(),
      isVerified: false,
      metadata: {},
    });

    await dbManager.addToken({
      address: 'token-b-address',
      symbol: 'TESTB',
      name: 'Test Token B',
      decimals: 6,
      firstSeen: Date.now(),
      isVerified: false,
      metadata: {},
    });

    await dbManager.addLiquidityPool({
      address: 'pool-address',
      dexName: 'TestDEX',
      tokenA: 'token-a-address',
      tokenB: 'token-b-address',
      createdAt: Date.now(),
      initialLiquidityUsd: 5000,
      lastUpdated: Date.now(),
      currentLiquidityUsd: 5000,
    });

    // Verify data was added
    const pools = await dbManager.getLiquidityPools();
    expect(pools).toHaveLength(1);
    expect(pools[0].address).toBe('pool-address');
  });

  test('should handle position tracking workflow', async () => {
    // Add test position
    await dbManager.addPosition({
      id: 'test-position-id',
      tokenAddress: 'token-address',
      entryPrice: 1.50,
      amount: 1000,
      openTimestamp: Date.now(),
      entryTradeId: 'test-trade-id',
      exitStrategy: {
        type: 'profit',
        enabled: true,
        params: { profitPercentage: 50 },
      },
      status: 'OPEN',
    });

    // Verify position was added
    const positions = await dbManager.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].id).toBe('test-position-id');
  });

  test('should handle event logging workflow', async () => {
    // Add test log events
    await dbManager.addLogEvent({
      level: 'info',
      message: 'Test log message',
      timestamp: Date.now(),
    });

    await dbManager.addLogEvent({
      level: 'error',
      message: 'Test error message',
      timestamp: Date.now(),
    });

    // Verify logs were added
    const logs = await dbManager.getRecentLogEvents(10);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });
});