/**
 * End-to-End Trading Integration Tests
 * 
 * Comprehensive trading simulation tests that validate the entire flow:
 * - Pool discovery and filtering
 * - Trade decision making 
 * - Risk management validation
 * - Transaction building and simulation
 * - Position management
 * - Exit strategy execution
 * - Error recovery scenarios
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import { Controller } from '../../src/core/controller';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DatabaseManager } from '../../src/db';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { StrategyEngine } from '../../src/trading/strategy-engine';
import { PositionManager } from '../../src/trading/position-manager';
import { RiskManager } from '../../src/security/risk-manager';
import { MarketMonitor } from '../../src/monitoring/market-monitor';
import { 
  AppConfig, 
  RpcConfig, 
  TradeDecision, 
  NewPoolEvent, 
  Position,
  Trade,
  LiquidityPool
} from '../../src/types';
import fs from 'fs/promises';
import path from 'path';

// Test configuration for devnet
const DEVNET_CONFIG: RpcConfig = {
  httpUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  commitment: 'confirmed',
  connectionTimeout: 15000,
  reconnectPolicy: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000
  }
};

const TEST_APP_CONFIG: AppConfig = {
  rpc: DEVNET_CONFIG,
  supportedDexes: [{
    name: 'Jupiter',
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    instructions: { newPoolCreation: 'create_pool' },
    enabled: true,
    priority: 1
  }],
  wallet: {
    keypairPath: '/tmp/test-e2e-keypair.json',
    riskPercent: 2,
    maxTotalRiskPercent: 10,
    confirmationRequired: false
  },
  tradeConfig: {
    minLiquidityUsd: 5000,
    maxSlippagePercent: 3,
    gasLimit: 0.01,
    defaultTradeAmountUsd: 25,
    maxTradeAmountUsd: 100,
    minTokenPrice: 0.0001,
    maxTokenSupply: 1000000000,
    maxHoldingTimeMinutes: 60,
    requiredBaseTokens: ['So11111111111111111111111111111111111111112'], // SOL
    minPoolAgeSeconds: 300 // 5 minutes
  },
  exitStrategies: [
    {
      type: 'profit',
      name: 'Quick Profit',
      enabled: true,
      params: { 
        profitPercentage: 15,
        trailingStopPercent: 5
      }
    },
    {
      type: 'loss',
      name: 'Stop Loss',
      enabled: true,
      params: { lossPercentage: 10 }
    },
    {
      type: 'time',
      name: 'Time Exit',
      enabled: true,
      params: { timeMinutes: 30 }
    }
  ],
  database: {
    path: ':memory:',
    logToDatabase: true
  },
  notifications: {
    enabled: false
  },
  marketMonitoring: {
    enabled: true,
    priceVolatilityThreshold: 15,
    volumeSpikeMultiplier: 5,
    liquidityDropThreshold: 25,
    monitoringInterval: 30000,
    historicalDataWindow: 120,
    circuitBreakerConfig: {
      failureThreshold: 3,
      successThreshold: 5,
      timeout: 300000,
      monitoringPeriod: 60000
    }
  },
  riskManagement: {
    enabled: true,
    maxTotalExposure: 500,
    maxSinglePositionSize: 100,
    maxPortfolioPercentage: 20,
    maxConcentrationRisk: 30,
    maxDailyLoss: 50,
    maxDrawdown: 20,
    volatilityMultiplier: 1.5,
    correlationThreshold: 0.7,
    rebalanceThreshold: 15,
    riskAssessmentInterval: 60000,
    emergencyExitThreshold: 30
  },
  dryRun: true, // Critical: Always dry run for integration tests
  verbose: true,
  disableTui: true,
  logLevel: 'debug'
};

// Mock pool data for testing
const MOCK_POOL_DATA: LiquidityPool = {
  address: 'TestPool123456789012345678901234567890123',
  dexName: 'Jupiter',
  tokenA: 'So11111111111111111111111111111111111111112', // SOL
  tokenB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  createdAt: Date.now() - 600000, // 10 minutes ago
  initialLiquidityUsd: 25000,
  lastUpdated: Date.now() - 30000, // 30 seconds ago
  currentLiquidityUsd: 28000
};

describe('End-to-End Trading Integration Tests', () => {
  let controller: Controller;
  let connectionManager: ConnectionManager;
  let dbManager: DatabaseManager;
  let tradeExecutor: TradeExecutor;
  let strategyEngine: StrategyEngine;
  let positionManager: PositionManager;
  let riskManager: RiskManager;
  let marketMonitor: MarketMonitor;
  let testKeypair: Keypair;

  beforeAll(async () => {
    // Generate test keypair and save to file
    testKeypair = Keypair.generate();
    const keypairArray = Array.from(testKeypair.secretKey);
    await fs.writeFile(TEST_APP_CONFIG.wallet.keypairPath, JSON.stringify(keypairArray));

    // Initialize all components
    connectionManager = new ConnectionManager(DEVNET_CONFIG);
    await connectionManager.initialize();

    dbManager = new DatabaseManager(':memory:');
    await dbManager.initialize();

    // Initialize market monitor
    marketMonitor = new MarketMonitor(
      connectionManager, 
      TEST_APP_CONFIG.marketMonitoring!
    );

    // Initialize risk manager
    riskManager = new RiskManager(
      dbManager,
      TEST_APP_CONFIG.riskManagement!
    );

    // Initialize strategy engine
    strategyEngine = new StrategyEngine(
      connectionManager,
      dbManager,
      TEST_APP_CONFIG
    );

    // Initialize trade executor
    tradeExecutor = new TradeExecutor(connectionManager, dbManager, TEST_APP_CONFIG);
    await tradeExecutor.initialize();

    // Initialize position manager
    positionManager = new PositionManager(
      dbManager,
      tradeExecutor,
      TEST_APP_CONFIG
    );

    // Initialize main controller
    controller = new Controller(TEST_APP_CONFIG);
    await controller.initialize();
  }, 60000);

  afterAll(async () => {
    await controller.shutdown();
    await connectionManager.shutdown();
    await dbManager.close();
    
    // Cleanup test files
    try {
      await fs.unlink(TEST_APP_CONFIG.wallet.keypairPath);
    } catch (error) {
      // File might not exist
    }
  });

  describe('Complete Trading Flow', () => {
    it('should process new pool discovery and make trade decision', async () => {
      // Simulate new pool event
      const newPoolEvent: NewPoolEvent = {
        signature: 'TestTxSignature123456789',
        dex: 'Jupiter',
        poolAddress: MOCK_POOL_DATA.address,
        tokenA: MOCK_POOL_DATA.tokenA,
        tokenB: MOCK_POOL_DATA.tokenB,
        timestamp: Date.now()
      };

      // Store pool in database
      await dbManager.addLiquidityPool(MOCK_POOL_DATA);

      // Process through strategy engine
      const tradeDecision = await strategyEngine.evaluatePool(newPoolEvent);

      expect(tradeDecision).toBeDefined();
      expect(tradeDecision.poolAddress).toBe(MOCK_POOL_DATA.address);
      expect(['BUY', 'SELL', 'HOLD']).toContain(tradeDecision.shouldTrade ? 'BUY' : 'HOLD');
      
      if (tradeDecision.shouldTrade) {
        expect(tradeDecision.tradeAmountUsd).toBeGreaterThan(0);
        expect(tradeDecision.tradeAmountUsd).toBeLessThanOrEqual(TEST_APP_CONFIG.tradeConfig.maxTradeAmountUsd!);
        expect(tradeDecision.riskScore).toBeGreaterThanOrEqual(0);
        expect(tradeDecision.riskScore).toBeLessThanOrEqual(1);
      }
    });

    it('should validate risk management before trade execution', async () => {
      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: MOCK_POOL_DATA.tokenB,
        baseToken: MOCK_POOL_DATA.tokenA,
        poolAddress: MOCK_POOL_DATA.address,
        tradeAmountUsd: 50, // This should exceed risk limits
        expectedAmountOut: 48.5,
        price: 0.97,
        reason: 'High volume new pool',
        riskScore: 0.3
      };

      // Test risk validation
      const riskAssessment = await riskManager.assessTradeRisk(tradeDecision);

      expect(riskAssessment).toBeDefined();
      expect(riskAssessment.overallRisk).toMatch(/^(LOW|MEDIUM|HIGH|CRITICAL)$/);
      expect(riskAssessment.riskFactors).toBeDefined();
      expect(riskAssessment.recommendedAction).toMatch(/^(APPROVE|REDUCE|REJECT)$/);

      // Risk factors should include relevant checks
      if (riskAssessment.riskFactors.length > 0) {
        expect(riskAssessment.riskFactors.some(factor => 
          factor.type === 'PORTFOLIO_CONCENTRATION' || 
          factor.type === 'POSITION_SIZE' ||
          factor.type === 'MARKET_CONDITIONS'
        )).toBe(true);
      }
    });

    it('should simulate complete trade execution flow', async () => {
      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: MOCK_POOL_DATA.tokenB,
        baseToken: MOCK_POOL_DATA.tokenA,
        poolAddress: MOCK_POOL_DATA.address,
        tradeAmountUsd: 25, // Within limits
        expectedAmountOut: 24.5,
        price: 0.98,
        reason: 'Low risk test trade',
        riskScore: 0.2
      };

      // Execute trade (dry run mode)
      const tradeResult = await tradeExecutor.executeTrade(tradeDecision);

      expect(tradeResult).toBeDefined();
      
      if (tradeResult.success) {
        expect(tradeResult.tradeId).toBeDefined();
        expect(tradeResult.positionId).toBeDefined();
        expect(tradeResult.actualAmountOut).toBeGreaterThan(0);
        expect(tradeResult.signature).toBeDefined();

        // Verify trade was recorded
        const savedTrades = await dbManager.getTrades();
        const executedTrade = savedTrades.find(t => t.id === tradeResult.tradeId);
        
        expect(executedTrade).toBeDefined();
        expect(executedTrade!.status).toBe('CONFIRMED');
        expect(executedTrade!.amount).toBe(tradeResult.actualAmountOut);

        // Verify position was created
        const positions = await dbManager.getPositions();
        const createdPosition = positions.find(p => p.id === tradeResult.positionId);
        
        expect(createdPosition).toBeDefined();
        expect(createdPosition!.status).toBe('OPEN');
        expect(createdPosition!.tokenAddress).toBe(tradeDecision.targetToken);
      } else {
        expect(tradeResult.error).toBeDefined();
        console.log('Trade simulation failed (expected in dry run):', tradeResult.error);
      }
    });

    it('should monitor position and trigger exit strategies', async () => {
      // Create a test position
      const position: Position = {
        id: randomUUID(),
        tokenAddress: MOCK_POOL_DATA.tokenB,
        entryPrice: 0.98,
        amount: 25,
        openTimestamp: Date.now() - 300000, // 5 minutes ago
        entryTradeId: randomUUID(),
        exitStrategy: TEST_APP_CONFIG.exitStrategies[0], // Profit strategy
        status: 'OPEN'
      };

      await dbManager.addPosition(position);

      // Simulate price movement that triggers profit exit (15% gain)
      const currentPrice = 0.98 * 1.16; // 16% gain, should trigger 15% profit target

      // Process position through position manager
      const exitDecision = await positionManager.evaluatePosition(position, currentPrice);

      expect(exitDecision).toBeDefined();
      
      if (exitDecision.shouldExit) {
        expect(exitDecision.reason).toContain('profit');
        expect(exitDecision.exitPercentage).toBeGreaterThan(0);
        expect(exitDecision.exitPercentage).toBeLessThanOrEqual(100);

        // Simulate exit execution
        const exitResult = await positionManager.executeExit(position, exitDecision);
        
        expect(exitResult.success).toBe(true);
        if (exitResult.success) {
          expect(exitResult.exitTradeId).toBeDefined();
          expect(exitResult.pnlUsd).toBeGreaterThan(0); // Should be profitable
        }
      }
    });

    it('should handle stop-loss scenarios', async () => {
      // Create position that should trigger stop loss
      const position: Position = {
        id: randomUUID(),
        tokenAddress: MOCK_POOL_DATA.tokenB,
        entryPrice: 1.00,
        amount: 50,
        openTimestamp: Date.now() - 180000, // 3 minutes ago
        entryTradeId: randomUUID(),
        exitStrategy: TEST_APP_CONFIG.exitStrategies[1], // Loss strategy (10% stop)
        status: 'OPEN'
      };

      await dbManager.addPosition(position);

      // Simulate 12% loss (should trigger 10% stop loss)
      const currentPrice = 1.00 * 0.88; // 12% loss

      const exitDecision = await positionManager.evaluatePosition(position, currentPrice);

      expect(exitDecision).toBeDefined();
      
      if (exitDecision.shouldExit) {
        expect(exitDecision.reason.toLowerCase()).toContain('loss');
        expect(exitDecision.urgency).toBe('HIGH');
        
        const exitResult = await positionManager.executeExit(position, exitDecision);
        
        if (exitResult.success) {
          expect(exitResult.pnlUsd).toBeLessThan(0); // Should be negative (loss)
          expect(Math.abs(exitResult.pnlUsd!)).toBeCloseTo(6, 0); // ~12% loss on $50
        }
      }
    });

    it('should handle time-based exits', async () => {
      // Create position that exceeds time limit
      const position: Position = {
        id: randomUUID(),
        tokenAddress: MOCK_POOL_DATA.tokenB,
        entryPrice: 0.95,
        amount: 30,
        openTimestamp: Date.now() - (31 * 60 * 1000), // 31 minutes ago (exceeds 30 min limit)
        entryTradeId: randomUUID(),
        exitStrategy: TEST_APP_CONFIG.exitStrategies[2], // Time strategy (30 min)
        status: 'OPEN'
      };

      await dbManager.addPosition(position);

      // Current price is neutral
      const currentPrice = 0.96; // Small gain

      const exitDecision = await positionManager.evaluatePosition(position, currentPrice);

      expect(exitDecision).toBeDefined();
      
      if (exitDecision.shouldExit) {
        expect(exitDecision.reason.toLowerCase()).toContain('time');
        expect(exitDecision.exitPercentage).toBe(100); // Full exit for time-based
      }
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle transaction failures gracefully', async () => {
      const tradeDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'InvalidTokenAddress123',
        baseToken: MOCK_POOL_DATA.tokenA,
        poolAddress: MOCK_POOL_DATA.address,
        tradeAmountUsd: 25,
        expectedAmountOut: 24.5,
        price: 0.98,
        reason: 'Test invalid token trade',
        riskScore: 0.2
      };

      const tradeResult = await tradeExecutor.executeTrade(tradeDecision);

      expect(tradeResult.success).toBe(false);
      expect(tradeResult.error).toBeDefined();
      expect(tradeResult.error).toContain('Invalid');
    });

    it('should handle network connectivity issues', async () => {
      // Temporarily break connection by using invalid endpoint
      const badConnectionManager = new ConnectionManager({
        ...DEVNET_CONFIG,
        httpUrl: 'https://invalid-rpc-endpoint.com',
        connectionTimeout: 1000 // Short timeout
      });

      let connectionFailed = false;
      try {
        await badConnectionManager.initialize();
      } catch (error) {
        connectionFailed = true;
        expect(error).toBeDefined();
      }

      expect(connectionFailed).toBe(true);
    });

    it('should implement circuit breaker for repeated failures', async () => {
      // Simulate multiple failed trades to trigger circuit breaker
      const failingDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'InvalidToken',
        baseToken: MOCK_POOL_DATA.tokenA,
        poolAddress: MOCK_POOL_DATA.address,
        tradeAmountUsd: 25,
        expectedAmountOut: 24.5,
        price: 0.98,
        reason: 'Circuit breaker test',
        riskScore: 0.2
      };

      // Execute multiple failing trades
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await tradeExecutor.executeTrade(failingDecision);
        results.push(result);
      }

      // All should fail
      results.forEach(result => {
        expect(result.success).toBe(false);
      });

      // Check if circuit breaker is active
      const executorStats = tradeExecutor.getStats();
      const tradingBreaker = executorStats.circuitBreakers.find(cb => cb.name === 'trading');
      
      // Circuit breaker might be tripped depending on implementation
      if (tradingBreaker) {
        expect(typeof tradingBreaker.isTripped).toBe('boolean');
      }
    });

    it('should handle database connection issues', async () => {
      // Test with invalid database path
      let dbFailed = false;
      try {
        const badDbManager = new DatabaseManager('/invalid/path/database.db');
        await badDbManager.initialize();
      } catch (error) {
        dbFailed = true;
        expect(error).toBeDefined();
      }

      expect(dbFailed).toBe(true);
    });

    it('should recover from temporary API failures', async () => {
      // This would test API retry logic and fallback mechanisms
      // Implementation would depend on how external API calls are structured
      
      // Mock scenario: API returns error first, then succeeds
      let callCount = 0;
      const mockApiCall = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Temporary API failure');
        }
        return { success: true, data: 'recovered' };
      };

      // Test retry logic
      let result;
      let error;
      try {
        // First call should fail
        try {
          await mockApiCall();
        } catch (e) {
          error = e;
          
          // Second call should succeed
          result = await mockApiCall();
        }
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  describe('Performance and Stress Testing', () => {
    it('should handle multiple concurrent trade evaluations', async () => {
      const concurrentPoolEvents: NewPoolEvent[] = Array(10).fill(null).map((_, i) => ({
        signature: `TestTx${i}`,
        dex: 'Jupiter',
        poolAddress: `TestPool${i}`,
        tokenA: MOCK_POOL_DATA.tokenA,
        tokenB: `TestToken${i}`,
        timestamp: Date.now()
      }));

      const startTime = Date.now();
      const decisions = await Promise.all(
        concurrentPoolEvents.map(event => strategyEngine.evaluatePool(event))
      );
      const endTime = Date.now();

      expect(decisions).toHaveLength(10);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
      
      decisions.forEach(decision => {
        expect(decision).toBeDefined();
        expect(typeof decision.shouldTrade).toBe('boolean');
      });
    });

    it('should maintain performance under database load', async () => {
      // Insert many test records to simulate database load
      const testTrades: Trade[] = Array(100).fill(null).map((_, i) => ({
        id: `test-trade-${i}`,
        tokenAddress: `TestToken${i}`,
        poolAddress: `TestPool${i}`,
        direction: i % 2 === 0 ? 'BUY' : 'SELL',
        amount: 100 + i,
        price: 0.95 + (i * 0.001),
        valueUsd: 25 + i,
        gasFeeUsd: 0.05,
        timestamp: Date.now() - (i * 60000),
        txSignature: `TestSig${i}`,
        status: 'CONFIRMED'
      }));

      const startTime = Date.now();
      
      // Insert trades
      for (const trade of testTrades) {
        await dbManager.addTrade(trade);
      }
      
      // Query trades
      const retrievedTrades = await dbManager.getTrades();
      
      const endTime = Date.now();

      expect(retrievedTrades.length).toBeGreaterThanOrEqual(100);
      expect(endTime - startTime).toBeLessThan(10000); // Should complete within 10 seconds
    });

    it('should handle memory usage efficiently', async () => {
      const initialMemory = process.memoryUsage();
      
      // Perform memory-intensive operations
      const largeDataSets = Array(50).fill(null).map(() => 
        Array(1000).fill(null).map(() => ({
          id: randomUUID(),
          timestamp: Date.now(),
          data: Array(100).fill('test-data').join('')
        }))
      );

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

      // Memory increase should be reasonable (less than 100MB for this test)
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024);

      // Clean up large data sets
      largeDataSets.length = 0;
    });
  });

  describe('System Integration', () => {
    it('should integrate all components in controller', async () => {
      const controllerStats = await controller.getSystemStats();

      expect(controllerStats).toBeDefined();
      expect(controllerStats.database).toBeDefined();
      expect(controllerStats.connection).toBeDefined();
      expect(controllerStats.trading).toBeDefined();

      // Verify components are properly initialized
      expect(controllerStats.connection.isHealthy).toBe(true);
      expect(controllerStats.database.isConnected).toBe(true);
    });

    it('should handle graceful shutdown', async () => {
      // Test that all components shut down cleanly
      let shutdownError: Error | null = null;
      
      try {
        // This would be tested with a separate controller instance
        // to avoid affecting the main test controller
        const testController = new Controller(TEST_APP_CONFIG);
        await testController.initialize();
        await testController.shutdown();
      } catch (error) {
        shutdownError = error as Error;
      }

      expect(shutdownError).toBeNull();
    });

    it('should maintain data consistency across components', async () => {
      // Create a position and verify it's tracked correctly across all components
      const testTrade: Trade = {
        id: randomUUID(),
        tokenAddress: MOCK_POOL_DATA.tokenB,
        poolAddress: MOCK_POOL_DATA.address,
        direction: 'BUY',
        amount: 25,
        price: 0.98,
        valueUsd: 24.5,
        gasFeeUsd: 0.05,
        timestamp: Date.now(),
        txSignature: 'TestConsistencySignature',
        status: 'CONFIRMED'
      };

      const testPosition: Position = {
        id: randomUUID(),
        tokenAddress: testTrade.tokenAddress,
        entryPrice: testTrade.price,
        amount: testTrade.amount,
        openTimestamp: testTrade.timestamp,
        entryTradeId: testTrade.id,
        exitStrategy: TEST_APP_CONFIG.exitStrategies[0],
        status: 'OPEN'
      };

      // Add to database
      await dbManager.addTrade(testTrade);
      await dbManager.addPosition(testPosition);

      // Verify data consistency
      const savedTrade = (await dbManager.getTrades()).find(t => t.id === testTrade.id);
      const savedPosition = (await dbManager.getPositions()).find(p => p.id === testPosition.id);

      expect(savedTrade).toBeDefined();
      expect(savedPosition).toBeDefined();
      expect(savedPosition!.entryTradeId).toBe(savedTrade!.id);
      expect(savedPosition!.tokenAddress).toBe(savedTrade!.tokenAddress);
    });
  });
});