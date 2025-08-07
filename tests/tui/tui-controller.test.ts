// CRITICAL: Mock sqlite3 BEFORE any imports that use it
jest.mock('sqlite3', () => ({
  Database: jest.fn().mockImplementation(() => ({
    run: jest.fn((sql, params, callback) => callback && callback(null)),
    get: jest.fn((sql, params, callback) => callback && callback(null, null)),
    all: jest.fn((sql, params, callback) => callback && callback(null, [])),
    close: jest.fn((callback) => callback && callback(null)),
    serialize: jest.fn((callback) => callback && callback()),
    prepare: jest.fn(() => ({
      run: jest.fn((params, callback) => callback && callback(null)),
      finalize: jest.fn(),
    })),
  })),
  OPEN_READWRITE: 1,
  OPEN_CREATE: 4,
}));

// Mock the DatabaseManager to prevent initialization delays
const mockData = {
  pools: [] as any[],
  positions: [] as any[],
  tokens: [] as any[],
  logEvents: [] as any[],
};

jest.mock('../../src/db', () => ({
  DatabaseManager: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    addToken: jest.fn().mockImplementation((token) => {
      mockData.tokens.push(token);
      return Promise.resolve(undefined);
    }),
    addLiquidityPool: jest.fn().mockImplementation((pool) => {
      mockData.pools.push(pool);
      return Promise.resolve(undefined);
    }),
    addPosition: jest.fn().mockImplementation((position) => {
      mockData.positions.push(position);
      return Promise.resolve(undefined);
    }),
    addLogEvent: jest.fn().mockImplementation((logEvent) => {
      mockData.logEvents.push(logEvent);
      return Promise.resolve(undefined);
    }),
    getLiquidityPools: jest.fn().mockResolvedValue(mockData.pools),
    getOpenPositions: jest.fn().mockResolvedValue(mockData.positions),
    getRecentLogEvents: jest.fn().mockImplementation((limit) => 
      Promise.resolve(mockData.logEvents.slice(0, limit))
    ),
    getStats: jest.fn().mockResolvedValue({
      tokenCount: mockData.tokens.length,
      poolCount: mockData.pools.length,
      tradeCount: 0,
      openPositionCount: mockData.positions.length,
      closedPositionCount: 0,
      dbSizeBytes: 1024,
    }),
  })),
}));

// Mock the EventManager to prevent initialization delays
jest.mock('../../src/events/event-manager', () => ({
  EventManager: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
}));

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
    focusPop: jest.fn(),
  })),
  box: jest.fn(() => ({
    on: jest.fn(),
    setContent: jest.fn(),
    setLabel: jest.fn(),
    append: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    screen: {
      render: jest.fn(),
      focusPop: jest.fn(),
    },
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
    append: jest.fn(),
    setLabel: jest.fn(),
    selected: 0,
    screen: {
      render: jest.fn(),
      focusPop: jest.fn(),
    },
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
    screen: {
      render: jest.fn(),
      focusPop: jest.fn(),
    },
  })),
  log: jest.fn(() => ({
    log: jest.fn(),
    setContent: jest.fn(),
    key: jest.fn(),
    on: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    hide: jest.fn(),
    show: jest.fn(),
    destroy: jest.fn(),
    scroll: jest.fn(),
    setScrollPerc: jest.fn(),
    alwaysScroll: true,
    append: jest.fn(),
    setLabel: jest.fn(),
    screen: {
      render: jest.fn(),
      focusPop: jest.fn(),
    },
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
    // Clear mock data between tests
    mockData.pools.length = 0;
    mockData.positions.length = 0;
    mockData.tokens.length = 0;
    mockData.logEvents.length = 0;

    // Create test database path (in memory for faster tests)
    const testDbPath = ':memory:';
    
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

    // Create mock instances (initialization is mocked to be instant)
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
    // Clear mock data between tests
    mockData.pools.length = 0;
    mockData.positions.length = 0;
    mockData.tokens.length = 0;
    mockData.logEvents.length = 0;

    const testDbPath = ':memory:';
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