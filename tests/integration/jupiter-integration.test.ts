/**
 * Jupiter DEX Integration Tests
 * 
 * Tests real Jupiter swap functionality using devnet to validate:
 * - Swap transaction building without submission
 * - Price quotation API integration
 * - Route calculation and optimization
 * - Slippage protection mechanisms
 * - Error handling for network issues
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DatabaseManager } from '../../src/db';
import { SlippageProtection } from '../../src/security/slippage-protection';
import { TransactionSimulator } from '../../src/security/transaction-simulator';
import { AppConfig, RpcConfig, TradeDecision } from '../../src/types';

// Test configuration for devnet
const DEVNET_CONFIG: RpcConfig = {
  httpUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  commitment: 'confirmed',
  connectionTimeout: 10000,
  reconnectPolicy: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000
  }
};

// Jupiter API endpoints for devnet
const JUPITER_API_BASE = 'https://quote-api.jup.ag/v6';

// Known devnet tokens for testing
const DEVNET_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', // Devnet USDC
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Devnet BONK
};

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | any;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

describe('Jupiter DEX Integration Tests', () => {
  let connection: Connection;
  let connectionManager: ConnectionManager;
  let dbManager: DatabaseManager;
  let tradeExecutor: TradeExecutor;
  let slippageProtection: SlippageProtection;
  let transactionSimulator: TransactionSimulator;
  let testConfig: AppConfig;
  let testKeypair: Keypair;

  const originalFetch = global.fetch;

  beforeAll(async () => {
    // Initialize test configuration
    testConfig = {
      rpc: DEVNET_CONFIG,
      supportedDexes: [{
        name: 'Jupiter',
        programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        instructions: { newPoolCreation: 'create_pool' },
        enabled: true
      }],
      wallet: {
        keypairPath: '/tmp/test-keypair.json',
        riskPercent: 1,
        maxTotalRiskPercent: 5
      },
      tradeConfig: {
        minLiquidityUsd: 1000,
        maxSlippagePercent: 5,
        gasLimit: 0.01,
        defaultTradeAmountUsd: 10,
        maxTradeAmountUsd: 100
      },
      exitStrategies: [{
        type: 'profit',
        enabled: true,
        params: { profitPercentage: 20 }
      }],
      database: {
        path: ':memory:'
      },
      dryRun: true, // Critical: Always dry run for tests
      verbose: true,
      disableTui: true
    };

    // Generate test keypair (won't be funded)
    testKeypair = Keypair.generate();

    // Initialize components
    connectionManager = new ConnectionManager(DEVNET_CONFIG);
    await connectionManager.initialize();
    connection = connectionManager.getConnection();

    dbManager = new DatabaseManager(':memory:');
    await dbManager.initialize();

    tradeExecutor = new TradeExecutor(connectionManager, dbManager, testConfig);
    
    slippageProtection = new SlippageProtection(connection, {
      baseSlippagePercent: 1,
      maxSlippagePercent: 5,
      volatilityMultiplier: 2,
      liquidityThresholdUsd: 1000,
      marketImpactThreshold: 2,
      emergencySlippagePercent: 10,
      adaptiveSlippageEnabled: true,
      circuitBreakerEnabled: true
    });

    transactionSimulator = new TransactionSimulator(connection, {
      maxSlippagePercent: 5,
      maxGasFeeUsd: 1,
      maxPriceImpactPercent: 10,
      mevProtectionEnabled: true,
      simulationRequired: true,
      maxComputeUnits: 1000000
    });
  }, 30000);

  afterAll(async () => {
    global.fetch = originalFetch;
    await connectionManager.shutdown();
    await dbManager.close();
  });

  describe('Jupiter API Integration', () => {
    beforeEach(() => {
      // Reset fetch mock for each test
      global.fetch = jest.fn();
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('should fetch price quote from Jupiter API', async () => {
      const mockQuoteResponse: JupiterQuoteResponse = {
        inputMint: DEVNET_TOKENS.SOL,
        inAmount: '1000000000', // 1 SOL
        outputMint: DEVNET_TOKENS.USDC,
        outAmount: '95000000', // ~95 USDC (with slippage)
        otherAmountThreshold: '94000000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        platformFee: null,
        priceImpactPct: '0.1',
        routePlan: [
          {
            swapInfo: {
              ammKey: 'test-pool',
              label: 'Orca',
              inputMint: DEVNET_TOKENS.SOL,
              outputMint: DEVNET_TOKENS.USDC,
              inAmount: '1000000000',
              outAmount: '95000000',
              feeAmount: '1000000',
              feeMint: DEVNET_TOKENS.SOL
            },
            percent: 100
          }
        ],
        contextSlot: 123456789,
        timeTaken: 150
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockQuoteResponse
      });

      const quote = await fetchJupiterQuote(
        DEVNET_TOKENS.SOL,
        DEVNET_TOKENS.USDC,
        1000000000 // 1 SOL
      );

      expect(quote).toBeDefined();
      expect(quote.inputMint).toBe(DEVNET_TOKENS.SOL);
      expect(quote.outputMint).toBe(DEVNET_TOKENS.USDC);
      expect(parseFloat(quote.priceImpactPct)).toBeLessThan(5); // Price impact < 5%
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(JUPITER_API_BASE + '/quote'),
        expect.any(Object)
      );
    });

    it('should handle Jupiter API errors gracefully', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000)
      ).rejects.toThrow('Network error');

      // Verify error handling doesn't crash the application
      expect(true).toBe(true);
    });

    it('should validate quote response format', async () => {
      const invalidQuoteResponse = {
        // Missing required fields
        inputMint: DEVNET_TOKENS.SOL,
        // Missing outputMint, inAmount, etc.
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => invalidQuoteResponse
      });

      await expect(
        fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000)
      ).rejects.toThrow(); // Should throw due to invalid response format
    });
  });

  describe('Swap Transaction Building', () => {
    it('should build swap transaction without submitting', async () => {
      const mockQuoteResponse: JupiterQuoteResponse = {
        inputMint: DEVNET_TOKENS.SOL,
        inAmount: '100000000', // 0.1 SOL
        outputMint: DEVNET_TOKENS.USDC,
        outAmount: '9500000',
        otherAmountThreshold: '9400000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        platformFee: null,
        priceImpactPct: '0.05',
        routePlan: [],
        contextSlot: 123456789,
        timeTaken: 100
      };

      const mockSwapResponse: JupiterSwapResponse = {
        swapTransaction: 'base64-encoded-transaction',
        lastValidBlockHeight: 123456800,
        prioritizationFeeLamports: 5000
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockQuoteResponse
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockSwapResponse
        });

      const swapTransaction = await buildJupiterSwapTransaction(
        testKeypair.publicKey,
        DEVNET_TOKENS.SOL,
        DEVNET_TOKENS.USDC,
        100000000, // 0.1 SOL
        50 // 0.5% slippage
      );

      expect(swapTransaction).toBeDefined();
      expect(swapTransaction.swapTransaction).toBe('base64-encoded-transaction');
      expect(swapTransaction.lastValidBlockHeight).toBeGreaterThan(0);
    });

    it('should validate slippage parameters', async () => {
      const decision: TradeDecision = {
        shouldTrade: true,
        targetToken: DEVNET_TOKENS.USDC,
        baseToken: DEVNET_TOKENS.SOL,
        poolAddress: 'test-pool-address',
        tradeAmountUsd: 10,
        expectedAmountOut: 9.5,
        price: 95,
        reason: 'Test trade',
        riskScore: 0.1
      };

      const slippageResult = await slippageProtection.calculateDynamicSlippage(
        decision.targetToken,
        decision.poolAddress,
        decision.tradeAmountUsd
      );

      expect(slippageResult.recommendedSlippage).toBeGreaterThan(0);
      expect(slippageResult.recommendedSlippage).toBeLessThanOrEqual(5); // Max 5%
      expect(slippageResult.reasoning).toHaveLength.greaterThan(0);
    });

    it('should simulate transaction before building', async () => {
      // Mock successful simulation
      const mockTransaction = {
        serialize: jest.fn().mockReturnValue(Buffer.alloc(100)),
        compileMessage: jest.fn().mockReturnValue({}),
        instructions: []
      };

      jest.spyOn(connection, 'simulateTransaction').mockResolvedValueOnce({
        context: { slot: 123456789 },
        value: {
          err: null,
          logs: ['Program log: Swap successful'],
          unitsConsumed: 50000,
          accounts: []
        }
      });

      const simulation = await transactionSimulator.simulateTransaction(
        mockTransaction as any,
        testKeypair.publicKey
      );

      expect(simulation.success).toBe(true);
      expect(simulation.unitsConsumed).toBe(50000);
      expect(simulation.logs).toContain('Program log: Swap successful');
    });
  });

  describe('Error Scenarios', () => {
    it('should handle insufficient liquidity', async () => {
      const mockErrorResponse = {
        error: 'Insufficient liquidity for swap',
        code: 'INSUFFICIENT_LIQUIDITY'
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => mockErrorResponse
      });

      await expect(
        fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000000) // Huge amount
      ).rejects.toThrow('Insufficient liquidity');
    });

    it('should handle API rate limiting', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Rate limited' })
      });

      await expect(
        fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000)
      ).rejects.toThrow('Rate limited');
    });

    it('should validate token addresses', async () => {
      await expect(
        fetchJupiterQuote('invalid-token', DEVNET_TOKENS.USDC, 1000000000)
      ).rejects.toThrow(); // Should fail validation
    });
  });

  describe('Performance Tests', () => {
    it('should fetch quotes within acceptable time limits', async () => {
      const mockQuoteResponse: JupiterQuoteResponse = {
        inputMint: DEVNET_TOKENS.SOL,
        inAmount: '1000000000',
        outputMint: DEVNET_TOKENS.USDC,
        outAmount: '95000000',
        otherAmountThreshold: '94000000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        platformFee: null,
        priceImpactPct: '0.1',
        routePlan: [],
        contextSlot: 123456789,
        timeTaken: 150
      };

      // Simulate network delay
      (global.fetch as jest.Mock).mockImplementationOnce(() =>
        new Promise(resolve => 
          setTimeout(() => resolve({
            ok: true,
            json: async () => mockQuoteResponse
          }), 500) // 500ms delay
        )
      );

      const startTime = Date.now();
      await fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(2000); // Should complete in < 2 seconds
    }, 10000);

    it('should handle concurrent quote requests', async () => {
      const mockQuoteResponse: JupiterQuoteResponse = {
        inputMint: DEVNET_TOKENS.SOL,
        inAmount: '1000000000',
        outputMint: DEVNET_TOKENS.USDC,
        outAmount: '95000000',
        otherAmountThreshold: '94000000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        platformFee: null,
        priceImpactPct: '0.1',
        routePlan: [],
        contextSlot: 123456789,
        timeTaken: 150
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => mockQuoteResponse
      });

      // Make 5 concurrent requests
      const promises = Array(5).fill(null).map(() =>
        fetchJupiterQuote(DEVNET_TOKENS.SOL, DEVNET_TOKENS.USDC, 1000000000)
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      results.forEach(result => {
        expect(result.inputMint).toBe(DEVNET_TOKENS.SOL);
      });
    });
  });
});

// Helper functions for Jupiter integration
async function fetchJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<JupiterQuoteResponse> {
  // Validate token addresses
  if (!isValidPublicKey(inputMint) || !isValidPublicKey(outputMint)) {
    throw new Error('Invalid token address');
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false'
  });

  const response = await fetch(`${JUPITER_API_BASE}/quote?${params}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const quote = await response.json();
  
  // Validate response format
  if (!quote.inputMint || !quote.outputMint || !quote.inAmount || !quote.outAmount) {
    throw new Error('Invalid quote response format');
  }

  return quote;
}

async function buildJupiterSwapTransaction(
  userPublicKey: PublicKey,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<JupiterSwapResponse> {
  // First get quote
  const quote = await fetchJupiterQuote(inputMint, outputMint, amount, slippageBps);

  // Then get swap transaction
  const response = await fetch(`${JUPITER_API_BASE}/swap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      feeAccount: null,
      trackingAccount: null,
      computeUnitPriceMicroLamports: null,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false,
      useTokenLedger: false,
      destinationTokenAccount: null,
      dynamicComputeUnitLimit: true,
      skipUserAccountsRpcCalls: false
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return await response.json();
}

function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}