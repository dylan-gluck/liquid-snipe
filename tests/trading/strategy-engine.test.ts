import {
  StrategyEngine,
  LiquidityThresholdStrategy,
  RiskAssessmentStrategy,
  BaseStrategy,
  StrategyContext,
  StrategyResult,
  TradeStrategy,
} from '../../src/trading/strategy-engine';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { TokenInfoService, TokenInfo } from '../../src/blockchain/token-info-service';
import { DatabaseManager } from '../../src/db';
import { NewPoolEvent, TradeDecision, AppConfig } from '../../src/types';

// Mock the dependencies
jest.mock('../../src/blockchain/connection-manager');
jest.mock('../../src/blockchain/token-info-service');
jest.mock('../../src/db');

describe('StrategyEngine', () => {
  let strategyEngine: StrategyEngine;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockTokenInfoService: jest.Mocked<TokenInfoService>;
  let mockDbManager: jest.Mocked<DatabaseManager>;
  let mockConfig: AppConfig;

  const mockPoolEvent: NewPoolEvent = {
    signature: 'mock-signature',
    dex: 'raydium',
    poolAddress: 'mock-pool-address',
    tokenA: 'token-a-address',
    tokenB: 'token-b-address',
    timestamp: Date.now(),
  };

  const mockStablecoinInfo: TokenInfo = {
    address: 'usdc-address',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    riskScore: 0,
    age: 365 * 24 * 60 * 60 * 1000,
    isVerified: true,
    metadata: {},
    lastUpdated: Date.now(),
  };

  const mockNewTokenInfo: TokenInfo = {
    address: 'new-token-address',
    symbol: 'NEW',
    name: 'New Token',
    decimals: 9,
    supply: 1000000000,
    riskScore: 4,
    age: 60 * 60 * 1000,
    isVerified: false,
    metadata: {},
    lastUpdated: Date.now(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnectionManager = {
      getConnection: jest.fn().mockReturnValue({
        // Mock connection object that FallbackLiquidityCalculator expects
        getTokenSupply: jest.fn().mockResolvedValue(1000000),
        getTokenAccountsByOwner: jest.fn().mockResolvedValue({ value: [] }),
      }),
    } as jest.Mocked<ConnectionManager>;
    mockDbManager = {} as jest.Mocked<DatabaseManager>;

    mockTokenInfoService = {
      getTokenInfo: jest.fn(),
      isNewToken: jest.fn(),
    } as any;

    mockConfig = {
      rpc: {
        httpUrl: 'http://localhost:8899',
        wsUrl: 'ws://localhost:8900',
      },
      supportedDexes: [],
      tradeConfig: {
        minLiquidityUsd: 1000,
        maxSlippagePercent: 2,
        gasLimit: 0.01,
        defaultTradeAmountUsd: 100,
        maxTradeAmountUsd: 1000,
        minTokenPrice: 0.0001,
        maxTokenSupply: 1000000000000,
        maxHoldingTimeMinutes: 60,
        requiredBaseTokens: ['USDC', 'SOL'],
        minPoolAgeSeconds: 0,
      },
      wallet: {
        keypairPath: './test-keypair.json',
        riskPercent: 5,
        maxTotalRiskPercent: 20,
        confirmationRequired: false,
        excludedTokens: [],
      },
      exitStrategies: [],
      database: {
        path: './test.db',
      },
      dryRun: false,
      verbose: false,
      disableTui: false,
    } as AppConfig;

    // Add mock PriceFeedService
    const mockPriceFeedService = {
      getTokenPrice: jest.fn(),
      getPoolLiquidity: jest.fn(),
    } as any;

    strategyEngine = new StrategyEngine(
      mockConnectionManager,
      mockTokenInfoService,
      mockPriceFeedService,
      mockDbManager,
      mockConfig,
    );
  });

  describe('constructor', () => {
    it('should initialize with default strategies', () => {
      const stats = strategyEngine.getStats();
      expect(stats.totalStrategies).toBe(2);
      expect(stats.strategies).toHaveLength(2);
      
      const strategyNames = stats.strategies.map(s => s.name);
      expect(strategyNames).toContain('liquidity-threshold');
      expect(strategyNames).toContain('risk-assessment');
    });

    it('should sort strategies by priority', () => {
      const stats = strategyEngine.getStats();
      const priorities = stats.strategies.map(s => s.priority);
      
      // Check that priorities are sorted in ascending order
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]);
      }
    });
  });

  describe('strategy management', () => {
    it('should add a custom strategy', () => {
      const customStrategy: TradeStrategy = {
        name: 'custom-test',
        description: 'Test strategy',
        priority: 5,
        evaluate: jest.fn().mockResolvedValue({
          shouldTrade: true,
          confidence: 0.8,
          reason: 'Test reason',
        }),
      };

      strategyEngine.addStrategy(customStrategy);
      
      const stats = strategyEngine.getStats();
      expect(stats.totalStrategies).toBe(3);
      expect(stats.strategies.some(s => s.name === 'custom-test')).toBe(true);
    });

    it('should remove a strategy by name', () => {
      const removed = strategyEngine.removeStrategy('liquidity-threshold');
      expect(removed).toBe(true);
      
      const stats = strategyEngine.getStats();
      expect(stats.totalStrategies).toBe(1);
      expect(stats.strategies.some(s => s.name === 'liquidity-threshold')).toBe(false);
    });

    it('should return false when removing non-existent strategy', () => {
      const removed = strategyEngine.removeStrategy('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('evaluatePool', () => {
    beforeEach(() => {
      mockTokenInfoService.getTokenInfo
        .mockResolvedValueOnce(mockStablecoinInfo)  // tokenA
        .mockResolvedValueOnce(mockNewTokenInfo);   // tokenB
      
      mockTokenInfoService.isNewToken.mockReturnValue(mockNewTokenInfo);
      
      // Mock pool liquidity
      jest.spyOn(strategyEngine, 'getPoolLiquidity').mockResolvedValue({
        totalLiquidityUsd: 5000,
        tokenAReserve: 1000000,
        tokenBReserve: 5000000,
        priceRatio: 0.0001,
        volume24h: 10000,
      });
    });

    it('should return null if token info cannot be retrieved', async () => {
      // Reset the previous mock setup and make it return null
      mockTokenInfoService.getTokenInfo.mockReset();
      mockTokenInfoService.getTokenInfo
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockNewTokenInfo);

      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      expect(result).toBeNull();
    });

    it('should return null if no new token is identified', async () => {
      mockTokenInfoService.isNewToken.mockReturnValue(null);

      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      expect(result).toBeNull();
    });

    it('should return null if pool liquidity cannot be retrieved', async () => {
      jest.spyOn(strategyEngine, 'getPoolLiquidity').mockResolvedValue(null);

      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      expect(result).toBeNull();
    });

    it('should return trade decision when all strategies approve', async () => {
      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      
      expect(result).not.toBeNull();
      expect(result!.shouldTrade).toBe(true);
      expect(result!.targetToken).toBe(mockNewTokenInfo.address);
      expect(result!.baseToken).toBe(mockStablecoinInfo.address);
      expect(result!.poolAddress).toBe(mockPoolEvent.poolAddress);
      expect(result!.tradeAmountUsd).toBeGreaterThan(0);
      expect(result!.riskScore).toBe(mockNewTokenInfo.riskScore);
    });

    it('should return rejection if any strategy rejects', async () => {
      // Mock high-risk token that will be rejected by liquidity threshold strategy first
      const highRiskToken = {
        ...mockNewTokenInfo,
        riskScore: 9, // High risk score
        symbol: undefined, // This will cause liquidity threshold strategy to reject it
      };
      
      mockTokenInfoService.getTokenInfo
        .mockResolvedValueOnce(mockStablecoinInfo)
        .mockResolvedValueOnce(highRiskToken);
      
      mockTokenInfoService.isNewToken.mockReturnValue(highRiskToken);

      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      
      expect(result).not.toBeNull();
      expect(result!.shouldTrade).toBe(false);
      expect(result!.reason).toContain('basic eligibility criteria');
    });

    it('should handle strategy evaluation errors gracefully', async () => {
      // Create a faulty strategy that throws an error
      const faultyStrategy: TradeStrategy = {
        name: 'faulty',
        description: 'Faulty strategy',
        priority: 0, // High priority to be evaluated first
        evaluate: jest.fn().mockRejectedValue(new Error('Strategy error')),
      };

      strategyEngine.addStrategy(faultyStrategy);

      const result = await strategyEngine.evaluatePool(mockPoolEvent);
      
      // Should still work with remaining strategies
      expect(result).not.toBeNull();
    });
  });

  describe('getPoolLiquidity', () => {
    it('should return mock liquidity data', async () => {
      // Mock the price feed service to return pool liquidity data
      const mockPriceFeedService2 = {
        getTokenPrice: jest.fn(),
        getPoolLiquidity: jest.fn().mockResolvedValue({
          totalLiquidityUsd: 25000,
          tokenA: { reserve: 1000000 },
          tokenB: { reserve: 25000000 },
          priceRatio: 0.00004,
          volume24h: 50000,
        }),
      } as any;

      const strategyEngine2 = new StrategyEngine(
        mockConnectionManager,
        mockTokenInfoService,
        mockPriceFeedService2,
        mockDbManager,
        mockConfig,
      );

      const result = await strategyEngine2.getPoolLiquidity('test-pool');
      
      expect(result).not.toBeNull();
      expect(result!.totalLiquidityUsd).toBeGreaterThan(1000);
      expect(result!.totalLiquidityUsd).toBeLessThan(52000);
      expect(result!.tokenAReserve).toBeGreaterThan(0);
      expect(result!.tokenBReserve).toBeGreaterThan(0);
    });
  });
});

describe('LiquidityThresholdStrategy', () => {
  let strategy: LiquidityThresholdStrategy;
  let mockContext: StrategyContext;

  beforeEach(() => {
    strategy = new LiquidityThresholdStrategy();
    
    mockContext = {
      poolEvent: {
        signature: 'sig',
        dex: 'raydium',
        poolAddress: 'pool',
        tokenA: 'tokenA',
        tokenB: 'tokenB',
        timestamp: Date.now(),
      },
      tokenAInfo: {
        address: 'tokenA',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        riskScore: 0,
        isVerified: true,
        metadata: {},
        lastUpdated: Date.now(),
      },
      tokenBInfo: {
        address: 'tokenB',
        symbol: 'NEW',
        name: 'New Token',
        decimals: 9,
        supply: 1000000,
        riskScore: 3,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      },
      newToken: {} as TokenInfo, // Will be set in tests
      baseToken: {} as TokenInfo, // Will be set in tests
      poolLiquidity: 5000,
      config: {
        minLiquidityUsd: 1000,
        maxSlippagePercent: 2,
        gasLimit: 0.01,
        defaultTradeAmountUsd: 100,
        maxTokenSupply: 1000000000,
      } as any,
      walletConfig: {
        riskPercent: 5,
      } as any,
    };

    mockContext.newToken = mockContext.tokenBInfo;
    mockContext.baseToken = mockContext.tokenAInfo;
  });

  it('should approve tokens with sufficient liquidity', async () => {
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reason).toContain('Good liquidity');
  });

  it('should reject tokens with insufficient liquidity', async () => {
    mockContext.poolLiquidity = 500; // Below minimum
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain('Insufficient liquidity');
  });

  it('should reject tokens without required metadata', async () => {
    mockContext.newToken.symbol = undefined;
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(false);
    expect(result.reason).toContain('basic eligibility criteria');
  });

  it('should reject tokens with excessive supply', async () => {
    mockContext.newToken.supply = 2000000000; // Above maxTokenSupply
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(false);
    expect(result.reason).toContain('basic eligibility criteria');
  });

  it('should reject tokens with high risk scores', async () => {
    mockContext.newToken.riskScore = 9;
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(false);
    expect(result.reason).toContain('basic eligibility criteria');
  });
});

describe('RiskAssessmentStrategy', () => {
  let strategy: RiskAssessmentStrategy;
  let mockContext: StrategyContext;

  beforeEach(() => {
    strategy = new RiskAssessmentStrategy();
    
    mockContext = {
      poolEvent: {
        signature: 'sig',
        dex: 'raydium',
        poolAddress: 'pool',
        tokenA: 'tokenA',
        tokenB: 'tokenB',
        timestamp: Date.now(),
      },
      tokenAInfo: {} as TokenInfo,
      tokenBInfo: {} as TokenInfo,
      newToken: {
        address: 'new-token',
        symbol: 'NEW',
        name: 'New Token',
        decimals: 9,
        riskScore: 4,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      },
      baseToken: {} as TokenInfo,
      poolLiquidity: 5000,
      config: {} as any,
      walletConfig: {
        riskPercent: 5,
      } as any,
    };
  });

  it('should approve low-risk tokens', async () => {
    mockContext.newToken.riskScore = 3;
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.recommendedAmount).toBeGreaterThan(0);
  });

  it('should reject high-risk tokens', async () => {
    mockContext.newToken.riskScore = 8;
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.shouldTrade).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toContain('Risk score too high');
  });

  it('should calculate position size based on risk', async () => {
    mockContext.newToken.riskScore = 2; // Low risk
    
    const result = await strategy.evaluate(mockContext);
    
    expect(result.recommendedAmount).toBeGreaterThan(0);
    expect(result.maxRisk).toBe(0.2); // 2/10
  });

  it('should adjust confidence based on liquidity', async () => {
    const lowLiquidityContext = { ...mockContext, poolLiquidity: 1000 };
    const highLiquidityContext = { ...mockContext, poolLiquidity: 20000 };
    
    const lowLiquidityResult = await strategy.evaluate(lowLiquidityContext);
    const highLiquidityResult = await strategy.evaluate(highLiquidityContext);
    
    expect(highLiquidityResult.confidence).toBeGreaterThan(lowLiquidityResult.confidence);
  });
});

describe('BaseStrategy', () => {
  class TestStrategy extends BaseStrategy {
    public readonly name = 'test';
    public readonly description = 'Test strategy';
    public readonly priority = 1;

    public async evaluate(context: StrategyContext): Promise<StrategyResult> {
      return {
        shouldTrade: true,
        confidence: 0.5,
        reason: 'Test',
      };
    }

    // Expose protected methods for testing
    public testCalculatePositionSize(
      availableCapital: number,
      riskPercentage: number,
      riskScore: number,
    ): number {
      return this.calculatePositionSize(availableCapital, riskPercentage, riskScore);
    }

    public testIsTokenEligible(tokenInfo: TokenInfo, config: any): boolean {
      return this.isTokenEligible(tokenInfo, config);
    }
  }

  let strategy: TestStrategy;

  beforeEach(() => {
    strategy = new TestStrategy();
  });

  describe('calculatePositionSize', () => {
    it('should reduce position size for high-risk tokens', () => {
      const lowRiskSize = strategy.testCalculatePositionSize(1000, 10, 2);
      const highRiskSize = strategy.testCalculatePositionSize(1000, 10, 8);
      
      expect(highRiskSize).toBeLessThan(lowRiskSize);
    });

    it('should never go below 10% of calculated amount', () => {
      const size = strategy.testCalculatePositionSize(1000, 10, 10); // Max risk
      expect(size).toBeGreaterThanOrEqual(10); // 1000 * 0.1 * 0.1 = 10
    });
  });

  describe('isTokenEligible', () => {
    const config = {
      maxTokenSupply: 1000000000,
      minTokenPrice: 0.0001,
    };

    it('should reject tokens without symbol', () => {
      const token: TokenInfo = {
        address: 'test',
        decimals: 9,
        riskScore: 3,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(false);
    });

    it('should reject tokens without decimals', () => {
      const token: TokenInfo = {
        address: 'test',
        symbol: 'TEST',
        riskScore: 3,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(false);
    });

    it('should reject tokens with excessive supply', () => {
      const token: TokenInfo = {
        address: 'test',
        symbol: 'TEST',
        decimals: 9,
        supply: 2000000000, // Above max
        riskScore: 3,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(false);
    });

    it('should reject tokens with price below minimum', () => {
      const token: TokenInfo = {
        address: 'test',
        symbol: 'TEST',
        decimals: 9,
        riskScore: 3,
        isVerified: false,
        metadata: { currentPrice: 0.00001 }, // Below min
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(false);
    });

    it('should reject tokens with very high risk scores', () => {
      const token: TokenInfo = {
        address: 'test',
        symbol: 'TEST',
        decimals: 9,
        riskScore: 9, // Very high risk
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(false);
    });

    it('should approve eligible tokens', () => {
      const token: TokenInfo = {
        address: 'test',
        symbol: 'TEST',
        decimals: 9,
        supply: 1000000,
        riskScore: 4,
        isVerified: false,
        metadata: { currentPrice: 0.001 },
        lastUpdated: Date.now(),
      };
      
      expect(strategy.testIsTokenEligible(token, config)).toBe(true);
    });
  });
});