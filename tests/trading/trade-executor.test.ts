import { Keypair, Connection, Transaction, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DatabaseManager } from '../../src/db';
import {
  TradeDecision,
  Trade,
  Position,
  AppConfig,
} from '../../src/types';

// Mock the dependencies
jest.mock('../../src/blockchain/connection-manager');
jest.mock('../../src/db');
jest.mock('fs');
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'mock-uuid-123'),
}));

// Mock @solana/web3.js Keypair
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Keypair: {
      ...actual.Keypair,
      fromSecretKey: jest.fn(),
    },
  };
});

describe('TradeExecutor', () => {
  let tradeExecutor: TradeExecutor;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockDbManager: jest.Mocked<DatabaseManager>;
  let mockConnection: jest.Mocked<Connection>;
  let mockConfig: AppConfig;

  const mockKeypair = {
    publicKey: new PublicKey('11111111111111111111111111111112'),
    secretKey: new Uint8Array(64),
  } as Keypair;

  const mockTradeDecision: TradeDecision = {
    shouldTrade: true,
    targetToken: 'target-token-address',
    baseToken: 'base-token-address',
    poolAddress: 'pool-address',
    tradeAmountUsd: 100,
    expectedAmountOut: 1000000,
    price: 0.0001,
    reason: 'Test trade',
    riskScore: 3,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock connection
    mockConnection = {
      getBalance: jest.fn(),
      getLatestBlockhash: jest.fn(),
      sendRawTransaction: jest.fn(),
      confirmTransaction: jest.fn(),
      getTransaction: jest.fn(),
    } as any;

    // Mock connection manager
    mockConnectionManager = {
      getConnection: jest.fn().mockReturnValue(mockConnection),
    } as any;

    // Mock database manager
    mockDbManager = {
      addTrade: jest.fn(),
      addPosition: jest.fn(),
    } as any;

    // Mock config
    mockConfig = {
      rpc: {
        httpUrl: 'http://localhost:8899',
        wsUrl: 'ws://localhost:8900',
      },
      supportedDexes: [],
      wallet: {
        keypairPath: './test-keypair.json',
        riskPercent: 5,
        maxTotalRiskPercent: 20,
        confirmationRequired: false,
        excludedTokens: [],
      },
      tradeConfig: {
        minLiquidityUsd: 1000,
        maxSlippagePercent: 2,
        gasLimit: 0.01,
        defaultTradeAmountUsd: 100,
        maxTradeAmountUsd: 1000,
        minTokenPrice: 0.0001,
        maxTokenSupply: 1000000000,
        minPoolAgeSeconds: 0,
        maxHoldingTimeMinutes: 60,
        requiredBaseTokens: ['USDC', 'SOL'],
      },
      exitStrategies: [
        {
          type: 'profit',
          enabled: true,
          params: {
            profitPercentage: 50,
          },
        },
      ],
      database: {
        path: './test.db',
      },
      dryRun: false,
      verbose: false,
      disableTui: false,
    } as AppConfig;

    // Mock file system
    (readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    );

    // Mock Keypair.fromSecretKey
    (Keypair.fromSecretKey as jest.Mock).mockReturnValue(mockKeypair);

    tradeExecutor = new TradeExecutor(
      mockConnectionManager,
      mockDbManager,
      mockConfig,
    );
  });

  describe('constructor', () => {
    it('should initialize with provided dependencies', () => {
      expect(tradeExecutor).toBeDefined();
      expect(mockConnectionManager.getConnection).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    it('should load wallet keypair and verify balance', async () => {
      mockConnection.getBalance.mockResolvedValue(100000000000); // 100 SOL = $10,000

      await tradeExecutor.initialize();

      expect(readFileSync).toHaveBeenCalledWith('./test-keypair.json', 'utf-8');
      expect(Keypair.fromSecretKey).toHaveBeenCalled();
      expect(mockConnection.getBalance).toHaveBeenCalledWith(mockKeypair.publicKey);
    });

    it('should throw error if keypair path not configured', async () => {
      const configWithoutKeypair = {
        ...mockConfig,
        wallet: { ...mockConfig.wallet, keypairPath: '' },
      };

      const executor = new TradeExecutor(
        mockConnectionManager,
        mockDbManager,
        configWithoutKeypair,
      );

      await expect(executor.initialize()).rejects.toThrow('Wallet keypair path not configured');
    });

    it('should throw error if keypair file cannot be read', async () => {
      (readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('File not found');
      });

      await expect(tradeExecutor.initialize()).rejects.toThrow('File not found');
    });
  });

  describe('executeTrade', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(100000000000); // 100 SOL = $10,000
      mockConnection.getLatestBlockhash.mockResolvedValue({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 1000,
      });
      mockConnection.sendRawTransaction.mockResolvedValue('mock-signature');
      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: null },
      });
      mockConnection.getTransaction.mockResolvedValue({
        meta: { 
          fee: 5000,
          preBalances: [1000000000],
          postBalances: [999995000],
          err: null,
        },
      } as any);

      await tradeExecutor.initialize();
    });

    it('should execute trade successfully', async () => {
      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(result.signature).toBe('mock-signature');
      expect(result.tradeId).toBe('mock-uuid-123');
      expect(result.positionId).toBe('mock-uuid-123');

      // Verify database calls
      expect(mockDbManager.addTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid-123',
          tokenAddress: 'target-token-address',
          direction: 'BUY',
          status: 'CONFIRMED',
        })
      );

      expect(mockDbManager.addPosition).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid-123',
          tokenAddress: 'target-token-address',
          status: 'OPEN',
        })
      );
    });

    it('should fail if wallet not initialized', async () => {
      const uninitializedExecutor = new TradeExecutor(
        mockConnectionManager,
        mockDbManager,
        mockConfig,
      );

      const result = await uninitializedExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Wallet not initialized');
    });

    it('should fail if insufficient SOL balance', async () => {
      mockConnection.getBalance.mockResolvedValue(5000); // Very low balance

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient SOL balance');
    });

    it('should fail if trade amount exceeds maximum', async () => {
      const largeTradeDecision = {
        ...mockTradeDecision,
        tradeAmountUsd: 2000, // Exceeds maxTradeAmountUsd of 1000
      };

      const result = await tradeExecutor.executeTrade(largeTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Trade amount exceeds maximum');
    });

    it('should fail if trade amount exceeds risk limit', async () => {
      // Mock smaller wallet balance for this test
      mockConnection.getBalance.mockResolvedValue(1000000000); // 1 SOL = $100

      const highRiskTradeDecision = {
        ...mockTradeDecision,
        tradeAmountUsd: 50, // Exceeds 5% risk limit of $5 (5% of $100)
      };

      const result = await tradeExecutor.executeTrade(highRiskTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Trade exceeds risk limit');
    });

    it('should handle transaction confirmation error', async () => {
      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: 'InsufficientFunds' },
      });

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction error');
    });

    it('should retry failed transactions', async () => {
      mockConnection.sendRawTransaction
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue('mock-signature');

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(2);
    });

    it('should fail after maximum retries', async () => {
      mockConnection.sendRawTransaction.mockRejectedValue(new Error('Persistent network error'));

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Persistent network error');
      expect(mockConnection.sendRawTransaction).toHaveBeenCalledTimes(3); // MAX_RETRIES
    });

    it('should record failed trade in database', async () => {
      mockConnection.sendRawTransaction.mockRejectedValue(new Error('Transaction failed'));

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(mockDbManager.addTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          amount: 0,
          txSignature: '',
        })
      );
    });
  });

  describe('getWalletBalance', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(100000000000); // 100 SOL = $10,000
      await tradeExecutor.initialize();
    });

    it('should return wallet balance', async () => {
      const balance = await tradeExecutor.getWalletBalance();

      expect(balance.sol).toBe(1); // 1 SOL
      expect(balance.totalValueUsd).toBe(100); // Mock $100 per SOL
      expect(balance.tokens).toBeInstanceOf(Map);
    });

    it('should fail if wallet not initialized', async () => {
      const uninitializedExecutor = new TradeExecutor(
        mockConnectionManager,
        mockDbManager,
        mockConfig,
      );

      await expect(uninitializedExecutor.getWalletBalance()).rejects.toThrow(
        'Wallet not initialized'
      );
    });

    it('should handle connection errors', async () => {
      mockConnection.getBalance.mockRejectedValue(new Error('Connection failed'));

      await expect(tradeExecutor.getWalletBalance()).rejects.toThrow('Connection failed');
    });
  });

  describe('getStats', () => {
    it('should return stats without wallet when not initialized', () => {
      const stats = tradeExecutor.getStats();

      expect(stats.walletAddress).toBeUndefined();
      expect(stats.circuitBreakers).toHaveLength(2);
      expect(stats.circuitBreakers[0].name).toBe('trading');
      expect(stats.circuitBreakers[0].isTripped).toBe(false);
    });

    it('should return stats with wallet address when initialized', async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);
      await tradeExecutor.initialize();

      const stats = tradeExecutor.getStats();

      expect(stats.walletAddress).toBe(mockKeypair.publicKey.toBase58());
      expect(stats.circuitBreakers).toHaveLength(2);
    });
  });

  describe('circuit breakers', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);
      await tradeExecutor.initialize();
    });

    it('should not trip circuit breaker on successful trades', async () => {
      mockConnection.sendRawTransaction.mockResolvedValue('mock-signature');
      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: null },
      });

      const result = await tradeExecutor.executeTrade(mockTradeDecision);
      expect(result.success).toBe(true);

      const stats = tradeExecutor.getStats();
      const tradingBreaker = stats.circuitBreakers.find(b => b.name === 'trading');
      expect(tradingBreaker?.isTripped).toBe(false);
    });

    it('should handle circuit breaker logic on failures', async () => {
      // Mock consecutive failures
      mockConnection.sendRawTransaction.mockRejectedValue(new Error('Network error'));

      // Execute multiple trades to potentially trip circuit breaker
      for (let i = 0; i < 3; i++) {
        await tradeExecutor.executeTrade(mockTradeDecision);
      }

      // Circuit breaker behavior depends on implementation details
      // This test ensures the system handles the logic without crashing
      const stats = tradeExecutor.getStats();
      expect(stats.circuitBreakers).toHaveLength(2);
    });
  });

  describe('transaction preparation', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);
      mockConnection.getLatestBlockhash.mockResolvedValue({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 1000,
      });
      await tradeExecutor.initialize();
    });

    it('should prepare transaction with proper blockhash and fee payer', async () => {
      mockConnection.sendRawTransaction.mockImplementation((serializedTx: any) => {
        // Verify transaction was properly prepared
        expect(serializedTx).toBeDefined();
        return Promise.resolve('mock-signature');
      });

      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: null },
      });

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalled();
    });

    it('should handle blockhash retrieval errors', async () => {
      mockConnection.getLatestBlockhash.mockRejectedValue(new Error('RPC error'));

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(false);
      expect(result.error).toContain('RPC error');
    });
  });

  describe('position creation', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);
      mockConnection.getLatestBlockhash.mockResolvedValue({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 1000,
      });
      mockConnection.sendRawTransaction.mockResolvedValue('mock-signature');
      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: null },
      });
      mockConnection.getTransaction.mockResolvedValue({
        meta: { 
          fee: 5000,
          preBalances: [1000000000],
          postBalances: [999995000],
          err: null,
        },
      } as any);
      await tradeExecutor.initialize();
    });

    it('should create position with correct attributes', async () => {
      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(mockDbManager.addPosition).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenAddress: mockTradeDecision.targetToken,
          entryPrice: mockTradeDecision.price,
          amount: mockTradeDecision.expectedAmountOut,
          status: 'OPEN',
          exitStrategy: mockConfig.exitStrategies[0],
        })
      );
    });

    it('should link position to trade', async () => {
      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);

      const tradeCall = mockDbManager.addTrade.mock.calls[0][0] as Trade;
      const positionCall = mockDbManager.addPosition.mock.calls[0][0] as Position;

      expect(positionCall.entryTradeId).toBe(tradeCall.id);
    });
  });

  describe('gas fee calculation', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);
      mockConnection.getLatestBlockhash.mockResolvedValue({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 1000,
      });
      mockConnection.sendRawTransaction.mockResolvedValue('mock-signature');
      mockConnection.confirmTransaction.mockResolvedValue({
        context: { slot: 1000 },
        value: { err: null },
      });
      await tradeExecutor.initialize();
    });

    it('should calculate gas fee from transaction details', async () => {
      mockConnection.getTransaction.mockResolvedValue({
        meta: { 
          fee: 10000,
          preBalances: [1000000000],
          postBalances: [999990000],
          err: null,
        },
      } as any);

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(mockDbManager.addTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          gasFeeUsd: 0.001, // 0.00001 SOL * $100 = $0.001
        })
      );
    });

    it('should handle missing transaction details', async () => {
      mockConnection.getTransaction.mockResolvedValue(null);

      const result = await tradeExecutor.executeTrade(mockTradeDecision);

      expect(result.success).toBe(true);
      expect(mockDbManager.addTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          gasFeeUsd: 0, // Default when transaction details unavailable
        })
      );
    });
  });
});