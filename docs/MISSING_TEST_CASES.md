# Critical Missing Test Cases for Liquid-Snipe

## Priority 1: Data Layer Tests

### tests/data/market-data-manager.test.ts
```typescript
import { MarketDataManager } from '../../src/data/market-data-manager';
import { PriceFeedService } from '../../src/data/price-feed-service';
import { ConnectionManager } from '../../src/blockchain/connection-manager';

jest.mock('../../src/data/price-feed-service');
jest.mock('../../src/blockchain/connection-manager');

describe('MarketDataManager', () => {
  let marketDataManager: MarketDataManager;
  let mockPriceFeed: jest.Mocked<PriceFeedService>;
  let mockConnection: jest.Mocked<ConnectionManager>;

  beforeEach(() => {
    mockPriceFeed = new PriceFeedService() as jest.Mocked<PriceFeedService>;
    mockConnection = new ConnectionManager() as jest.Mocked<ConnectionManager>;
    marketDataManager = new MarketDataManager(mockPriceFeed, mockConnection);
  });

  describe('price data aggregation', () => {
    it('should aggregate prices from multiple sources', async () => {
      const tokenAddress = 'test-token-address';
      mockPriceFeed.getPrice.mockResolvedValue({ price: 100, timestamp: Date.now() });
      
      const aggregatedPrice = await marketDataManager.getAggregatedPrice(tokenAddress);
      
      expect(aggregatedPrice).toBeDefined();
      expect(aggregatedPrice.price).toBeGreaterThan(0);
    });

    it('should handle price feed failures gracefully', async () => {
      const tokenAddress = 'test-token-address';
      mockPriceFeed.getPrice.mockRejectedValue(new Error('Feed unavailable'));
      
      const result = await marketDataManager.getAggregatedPrice(tokenAddress);
      
      expect(result).toBeNull(); // or appropriate fallback behavior
    });

    it('should detect price anomalies', async () => {
      const tokenAddress = 'test-token-address';
      const historicalPrices = [100, 101, 99, 102, 98]; // Normal variation
      const anomalousPrice = 200; // 100% spike
      
      mockPriceFeed.getHistoricalPrices.mockResolvedValue(historicalPrices);
      
      const isAnomalous = await marketDataManager.detectPriceAnomaly(
        tokenAddress, 
        anomalousPrice
      );
      
      expect(isAnomalous).toBe(true);
    });
  });

  describe('data quality validation', () => {
    it('should validate price data freshness', async () => {
      const staleTimestamp = Date.now() - (5 * 60 * 1000); // 5 minutes ago
      mockPriceFeed.getPrice.mockResolvedValue({ 
        price: 100, 
        timestamp: staleTimestamp 
      });
      
      const isValid = await marketDataManager.validateDataFreshness('test-token');
      
      expect(isValid).toBe(false);
    });

    it('should handle missing price data', async () => {
      mockPriceFeed.getPrice.mockResolvedValue(null);
      
      const price = await marketDataManager.getAggregatedPrice('invalid-token');
      
      expect(price).toBeNull();
    });
  });

  describe('caching and performance', () => {
    it('should cache recent price data', async () => {
      const tokenAddress = 'test-token';
      const priceData = { price: 100, timestamp: Date.now() };
      
      mockPriceFeed.getPrice.mockResolvedValue(priceData);
      
      // First call
      await marketDataManager.getAggregatedPrice(tokenAddress);
      // Second call should use cache
      await marketDataManager.getAggregatedPrice(tokenAddress);
      
      expect(mockPriceFeed.getPrice).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache when data becomes stale', async () => {
      const tokenAddress = 'test-token';
      jest.useFakeTimers();
      
      mockPriceFeed.getPrice.mockResolvedValue({ 
        price: 100, 
        timestamp: Date.now() 
      });
      
      await marketDataManager.getAggregatedPrice(tokenAddress);
      
      // Fast forward time beyond cache TTL
      jest.advanceTimersByTime(60000); // 1 minute
      
      await marketDataManager.getAggregatedPrice(tokenAddress);
      
      expect(mockPriceFeed.getPrice).toHaveBeenCalledTimes(2);
      
      jest.useRealTimers();
    });
  });
});
```

### tests/monitoring/price-feed-monitor.test.ts
```typescript
import { PriceFeedMonitor } from '../../src/monitoring/price-feed-monitor';
import { EventManager } from '../../src/events/event-manager';
import { Logger } from '../../src/utils/logger';

jest.mock('../../src/events/event-manager');
jest.mock('../../src/utils/logger');

describe('PriceFeedMonitor', () => {
  let monitor: PriceFeedMonitor;
  let mockEventManager: jest.Mocked<EventManager>;

  beforeEach(() => {
    mockEventManager = new EventManager() as jest.Mocked<EventManager>;
    monitor = new PriceFeedMonitor(mockEventManager);
  });

  describe('feed health monitoring', () => {
    it('should detect feed outages', async () => {
      const feedUrl = 'https://api.example.com/prices';
      
      // Simulate feed failure
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
      
      await monitor.checkFeedHealth(feedUrl);
      
      expect(mockEventManager.emit).toHaveBeenCalledWith(
        'price-feed-outage',
        expect.objectContaining({ feedUrl, error: expect.any(String) })
      );
    });

    it('should track feed latency', async () => {
      const feedUrl = 'https://api.example.com/prices';
      
      jest.spyOn(global, 'fetch').mockImplementation(() =>
        new Promise(resolve => 
          setTimeout(() => resolve(new Response('{"price": 100}')), 2000)
        )
      );
      
      const latency = await monitor.measureFeedLatency(feedUrl);
      
      expect(latency).toBeGreaterThan(2000);
    });

    it('should detect price staleness', async () => {
      const priceData = {
        price: 100,
        timestamp: Date.now() - (10 * 60 * 1000) // 10 minutes old
      };
      
      const isStale = monitor.isPriceStale(priceData, 5 * 60 * 1000); // 5 min threshold
      
      expect(isStale).toBe(true);
    });
  });

  describe('alert management', () => {
    it('should throttle alert notifications', async () => {
      const alertType = 'feed-outage';
      
      // Send multiple alerts quickly
      await monitor.sendAlert(alertType, 'Feed 1 down');
      await monitor.sendAlert(alertType, 'Feed 1 still down');
      await monitor.sendAlert(alertType, 'Feed 1 really down');
      
      // Should only emit one alert due to throttling
      expect(mockEventManager.emit).toHaveBeenCalledTimes(1);
    });
  });
});
```

## Priority 2: State Machine Tests

### tests/core/state-machines/system-state-machine.test.ts
```typescript
import { SystemStateMachine, SystemState } from '../../../src/core/state-machines/system-state-machine';
import { EventManager } from '../../../src/events/event-manager';

describe('SystemStateMachine', () => {
  let stateMachine: SystemStateMachine;
  let mockEventManager: jest.Mocked<EventManager>;

  beforeEach(() => {
    mockEventManager = new EventManager() as jest.Mocked<EventManager>;
    stateMachine = new SystemStateMachine(mockEventManager);
  });

  describe('state transitions', () => {
    it('should initialize in INITIALIZING state', () => {
      expect(stateMachine.getCurrentState()).toBe(SystemState.INITIALIZING);
    });

    it('should transition from INITIALIZING to READY', async () => {
      expect(stateMachine.getCurrentState()).toBe(SystemState.INITIALIZING);
      
      await stateMachine.transitionTo(SystemState.READY);
      
      expect(stateMachine.getCurrentState()).toBe(SystemState.READY);
    });

    it('should prevent invalid state transitions', async () => {
      // Cannot go directly from INITIALIZING to EMERGENCY
      expect(stateMachine.getCurrentState()).toBe(SystemState.INITIALIZING);
      
      await expect(
        stateMachine.transitionTo(SystemState.EMERGENCY)
      ).rejects.toThrow('Invalid state transition');
    });

    it('should allow emergency transitions from any state', async () => {
      await stateMachine.transitionTo(SystemState.READY);
      expect(stateMachine.getCurrentState()).toBe(SystemState.READY);
      
      await stateMachine.transitionTo(SystemState.EMERGENCY);
      expect(stateMachine.getCurrentState()).toBe(SystemState.EMERGENCY);
    });
  });

  describe('state persistence', () => {
    it('should save state on transitions', async () => {
      const saveSpy = jest.spyOn(stateMachine, 'saveState');
      
      await stateMachine.transitionTo(SystemState.READY);
      
      expect(saveSpy).toHaveBeenCalledWith(SystemState.READY);
    });

    it('should restore state on startup', async () => {
      // Mock persisted state
      jest.spyOn(stateMachine, 'loadState').mockResolvedValue(SystemState.READY);
      
      await stateMachine.restore();
      
      expect(stateMachine.getCurrentState()).toBe(SystemState.READY);
    });
  });

  describe('state validation', () => {
    it('should validate system health before transitions', async () => {
      const healthCheckSpy = jest.spyOn(stateMachine, 'performHealthCheck')
        .mockResolvedValue(false);
      
      await expect(
        stateMachine.transitionTo(SystemState.ACTIVE)
      ).rejects.toThrow('Health check failed');
      
      expect(healthCheckSpy).toHaveBeenCalled();
    });
  });
});
```

### tests/core/state-machines/position-state-machine.test.ts
```typescript
import { 
  PositionStateMachine, 
  PositionState 
} from '../../../src/core/state-machines/position-state-machine';
import { Position } from '../../../src/types';

describe('PositionStateMachine', () => {
  let stateMachine: PositionStateMachine;
  let mockPosition: Position;

  beforeEach(() => {
    mockPosition = {
      id: 'test-position-1',
      tokenAddress: 'test-token',
      entryPrice: 100,
      quantity: 1000,
      status: 'open',
      timestamp: Date.now()
    } as Position;
    
    stateMachine = new PositionStateMachine(mockPosition);
  });

  describe('position lifecycle', () => {
    it('should start in OPENING state', () => {
      expect(stateMachine.getCurrentState()).toBe(PositionState.OPENING);
    });

    it('should transition to OPEN after successful entry', async () => {
      await stateMachine.confirmEntry(100, 1000);
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.OPEN);
    });

    it('should transition to CLOSING when exit is initiated', async () => {
      await stateMachine.confirmEntry(100, 1000);
      await stateMachine.initiateExit();
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.CLOSING);
    });

    it('should transition to CLOSED after successful exit', async () => {
      await stateMachine.confirmEntry(100, 1000);
      await stateMachine.initiateExit();
      await stateMachine.confirmExit(110, Date.now());
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.CLOSED);
    });
  });

  describe('error handling', () => {
    it('should transition to FAILED on entry failure', async () => {
      await stateMachine.handleEntryFailure(new Error('Insufficient funds'));
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.FAILED);
    });

    it('should retry failed positions', async () => {
      await stateMachine.handleEntryFailure(new Error('Network error'));
      
      const canRetry = stateMachine.canRetry();
      expect(canRetry).toBe(true);
      
      await stateMachine.retry();
      expect(stateMachine.getCurrentState()).toBe(PositionState.OPENING);
    });
  });

  describe('stop loss and take profit', () => {
    it('should trigger stop loss transition', async () => {
      await stateMachine.confirmEntry(100, 1000);
      stateMachine.setStopLoss(90); // 10% stop loss
      
      await stateMachine.checkStopLoss(85); // Price below stop loss
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.CLOSING);
    });

    it('should trigger take profit transition', async () => {
      await stateMachine.confirmEntry(100, 1000);
      stateMachine.setTakeProfit(120); // 20% take profit
      
      await stateMachine.checkTakeProfit(125); // Price above take profit
      
      expect(stateMachine.getCurrentState()).toBe(PositionState.CLOSING);
    });
  });
});
```

## Priority 3: Workflow Tests

### tests/core/workflows/data-management-workflow.test.ts
```typescript
import { DataManagementWorkflow } from '../../../src/core/workflows/data-management-workflow';
import { MarketDataManager } from '../../../src/data/market-data-manager';
import { DatabaseManager } from '../../../src/db';

jest.mock('../../../src/data/market-data-manager');
jest.mock('../../../src/db');

describe('DataManagementWorkflow', () => {
  let workflow: DataManagementWorkflow;
  let mockMarketData: jest.Mocked<MarketDataManager>;
  let mockDb: jest.Mocked<DatabaseManager>;

  beforeEach(() => {
    mockMarketData = new MarketDataManager() as jest.Mocked<MarketDataManager>;
    mockDb = new DatabaseManager() as jest.Mocked<DatabaseManager>;
    workflow = new DataManagementWorkflow(mockMarketData, mockDb);
  });

  describe('data synchronization', () => {
    it('should sync market data to database', async () => {
      const marketData = [
        { tokenAddress: 'token1', price: 100, timestamp: Date.now() },
        { tokenAddress: 'token2', price: 200, timestamp: Date.now() }
      ];
      
      mockMarketData.getLatestData.mockResolvedValue(marketData);
      mockDb.bulkInsert.mockResolvedValue(true);
      
      const result = await workflow.synchronizeMarketData();
      
      expect(result.success).toBe(true);
      expect(mockDb.bulkInsert).toHaveBeenCalledWith('market_data', marketData);
    });

    it('should handle sync failures gracefully', async () => {
      mockMarketData.getLatestData.mockRejectedValue(new Error('API error'));
      
      const result = await workflow.synchronizeMarketData();
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('data cleanup', () => {
    it('should archive old data', async () => {
      const cutoffDate = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days ago
      
      mockDb.countRecords.mockResolvedValue(1000);
      mockDb.archiveOldRecords.mockResolvedValue(500);
      
      const result = await workflow.archiveOldData(cutoffDate);
      
      expect(result.archivedCount).toBe(500);
      expect(mockDb.archiveOldRecords).toHaveBeenCalledWith('market_data', cutoffDate);
    });

    it('should validate data integrity', async () => {
      mockDb.validateDataIntegrity.mockResolvedValue({
        isValid: true,
        corruptedRecords: []
      });
      
      const result = await workflow.validateDataIntegrity();
      
      expect(result.isValid).toBe(true);
    });
  });
});
```

### tests/core/workflows/error-recovery-workflow.test.ts
```typescript
import { ErrorRecoveryWorkflow } from '../../../src/core/workflows/error-recovery-workflow';
import { SystemStateMachine } from '../../../src/core/state-machines/system-state-machine';
import { EventManager } from '../../../src/events/event-manager';

describe('ErrorRecoveryWorkflow', () => {
  let workflow: ErrorRecoveryWorkflow;
  let mockStateMachine: jest.Mocked<SystemStateMachine>;
  let mockEventManager: jest.Mocked<EventManager>;

  beforeEach(() => {
    mockStateMachine = new SystemStateMachine() as jest.Mocked<SystemStateMachine>;
    mockEventManager = new EventManager() as jest.Mocked<EventManager>;
    workflow = new ErrorRecoveryWorkflow(mockStateMachine, mockEventManager);
  });

  describe('error detection', () => {
    it('should detect system errors', async () => {
      const error = new Error('Critical system failure');
      
      const isRecoverable = await workflow.assessError(error);
      
      expect(typeof isRecoverable).toBe('boolean');
    });

    it('should categorize error severity', async () => {
      const criticalError = new Error('Database connection lost');
      const minorError = new Error('Price feed timeout');
      
      const criticalSeverity = await workflow.categorizeError(criticalError);
      const minorSeverity = await workflow.categorizeError(minorError);
      
      expect(criticalSeverity).toBe('CRITICAL');
      expect(minorSeverity).toBe('WARNING');
    });
  });

  describe('recovery strategies', () => {
    it('should attempt automatic recovery', async () => {
      const error = new Error('Connection timeout');
      mockStateMachine.getCurrentState.mockReturnValue('ERROR');
      
      const recoveryResult = await workflow.attemptRecovery(error);
      
      expect(recoveryResult.attempted).toBe(true);
    });

    it('should escalate unrecoverable errors', async () => {
      const criticalError = new Error('Hardware wallet disconnected');
      
      await workflow.attemptRecovery(criticalError);
      
      expect(mockEventManager.emit).toHaveBeenCalledWith(
        'error-escalation',
        expect.objectContaining({
          error: criticalError,
          requiresManualIntervention: true
        })
      );
    });
  });

  describe('recovery validation', () => {
    it('should validate successful recovery', async () => {
      mockStateMachine.getCurrentState.mockReturnValue('READY');
      
      const isRecovered = await workflow.validateRecovery();
      
      expect(isRecovered).toBe(true);
    });

    it('should detect failed recovery attempts', async () => {
      mockStateMachine.getCurrentState.mockReturnValue('ERROR');
      
      const isRecovered = await workflow.validateRecovery();
      
      expect(isRecovered).toBe(false);
    });
  });
});
```

## Priority 4: Performance Tests

### tests/performance/trading-latency.test.ts
```typescript
import { TradeExecutor } from '../../src/trading/trade-executor';
import { StrategyEngine } from '../../src/trading/strategy-engine';
import { RiskManager } from '../../src/security/risk-manager';
import { performance } from 'perf_hooks';

describe('Trading Latency Performance', () => {
  let tradeExecutor: TradeExecutor;
  let strategyEngine: StrategyEngine;
  let riskManager: RiskManager;

  beforeAll(() => {
    // Initialize with test configuration
    tradeExecutor = new TradeExecutor(mockConfig);
    strategyEngine = new StrategyEngine(mockConfig);
    riskManager = new RiskManager(mockConfig);
  });

  describe('decision latency', () => {
    it('should make trading decisions within 100ms', async () => {
      const poolEvent = mockNewPoolEvent();
      
      const startTime = performance.now();
      const decision = await strategyEngine.evaluatePool(poolEvent);
      const endTime = performance.now();
      
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(100); // 100ms requirement
      expect(decision).toBeDefined();
    });

    it('should perform risk assessment within 50ms', async () => {
      const tradeDecision = mockTradeDecision();
      
      const startTime = performance.now();
      const riskAssessment = await riskManager.assessRisk(tradeDecision);
      const endTime = performance.now();
      
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(50); // 50ms requirement
      expect(riskAssessment).toBeDefined();
    });
  });

  describe('execution latency', () => {
    it('should execute trades within 500ms', async () => {
      const tradeRequest = mockTradeRequest();
      
      const startTime = performance.now();
      const result = await tradeExecutor.executeTrade(tradeRequest);
      const endTime = performance.now();
      
      const latency = endTime - startTime;
      expect(latency).toBeLessThan(500); // 500ms requirement
      expect(result.success).toBe(true);
    });
  });

  describe('memory performance', () => {
    it('should not leak memory during continuous trading', async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Simulate continuous trading for 1000 iterations
      for (let i = 0; i < 1000; i++) {
        const poolEvent = mockNewPoolEvent();
        await strategyEngine.evaluatePool(poolEvent);
        
        if (i % 100 === 0) {
          global.gc?.(); // Force garbage collection if available
        }
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      // Memory growth should be reasonable (less than 100MB)
      expect(memoryGrowth).toBeLessThan(100 * 1024 * 1024);
    });
  });

  describe('concurrent performance', () => {
    it('should handle multiple simultaneous pool evaluations', async () => {
      const poolEvents = Array(50).fill(null).map(() => mockNewPoolEvent());
      
      const startTime = performance.now();
      const results = await Promise.all(
        poolEvents.map(event => strategyEngine.evaluatePool(event))
      );
      const endTime = performance.now();
      
      const avgLatency = (endTime - startTime) / poolEvents.length;
      expect(avgLatency).toBeLessThan(200); // Average should be under 200ms
      expect(results).toHaveLength(50);
    });
  });
});
```

## Priority 5: Edge Case Tests

### tests/integration/network-failure-scenarios.test.ts
```typescript
import { Controller } from '../../src/core/controller';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import nock from 'nock';

describe('Network Failure Scenarios', () => {
  let controller: Controller;
  let connectionManager: ConnectionManager;

  beforeEach(() => {
    connectionManager = new ConnectionManager(testConfig.rpc);
    controller = new Controller(testConfig);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('RPC endpoint failures', () => {
    it('should handle complete RPC endpoint failure', async () => {
      // Mock RPC endpoint returning 500 errors
      nock('https://api.devnet.solana.com')
        .post('/')
        .times(5)
        .reply(500, { error: 'Internal server error' });

      const result = await connectionManager.getConnection();
      
      expect(result).toBeNull(); // Should fail gracefully
    });

    it('should failover to backup RPC endpoints', async () => {
      const backupConfig = {
        ...testConfig.rpc,
        backupUrls: ['https://backup1.solana.com', 'https://backup2.solana.com']
      };

      // Primary fails
      nock('https://api.devnet.solana.com')
        .post('/')
        .reply(500);

      // Backup succeeds
      nock('https://backup1.solana.com')
        .post('/')
        .reply(200, { result: 'success' });

      connectionManager = new ConnectionManager(backupConfig);
      const connection = await connectionManager.getConnection();
      
      expect(connection).toBeDefined();
    });
  });

  describe('WebSocket connection failures', () => {
    it('should reconnect on WebSocket disconnection', async () => {
      const reconnectSpy = jest.spyOn(connectionManager, 'reconnect');
      
      // Simulate WebSocket disconnection
      connectionManager.emit('disconnect');
      
      // Wait for reconnect attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      expect(reconnectSpy).toHaveBeenCalled();
    });

    it('should queue messages during disconnection', async () => {
      // Simulate disconnection
      connectionManager.emit('disconnect');
      
      // Send message while disconnected
      const messagePromise = connectionManager.sendMessage({ method: 'test' });
      
      // Reconnect
      connectionManager.emit('connect');
      
      const result = await messagePromise;
      expect(result).toBeDefined();
    });
  });

  describe('transaction failures', () => {
    it('should handle transaction timeout', async () => {
      nock('https://api.devnet.solana.com')
        .post('/')
        .delay(10000) // 10 second delay
        .reply(200);

      const tradeRequest = mockTradeRequest();
      const result = await controller.executeTrade(tradeRequest);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should retry failed transactions', async () => {
      const sendTransactionSpy = jest.spyOn(connectionManager, 'sendTransaction');
      
      // First call fails, second succeeds
      sendTransactionSpy
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ signature: 'success-sig' });

      const result = await controller.executeTrade(mockTradeRequest());
      
      expect(sendTransactionSpy).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });
  });
});
```

---

These test cases address the critical gaps identified in the coverage analysis and provide comprehensive testing for the most important aspects of the Liquid-Snipe trading bot system.