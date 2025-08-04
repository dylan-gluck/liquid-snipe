import { EventEmitter } from 'events';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { BlockchainWatcher, WatcherStatus } from '../../src/blockchain/blockchain-watcher';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DexConfig, NewPoolEvent } from '../../src/types';

// Mock the Solana web3.js
jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn(),
  PublicKey: jest.fn(),
  Commitment: {}
}));

describe('BlockchainWatcher', () => {
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockConnection: jest.Mocked<Connection>;
  let blockchainWatcher: BlockchainWatcher;
  let testDexConfigs: DexConfig[];

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock connection
    mockConnection = {
      onLogs: jest.fn(),
      removeOnLogsListener: jest.fn(),
      getParsedTransaction: jest.fn()
    } as any;

    // Create mock connection manager
    mockConnectionManager = {
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getStatus: jest.fn().mockReturnValue({ isConnected: true }),
      on: jest.fn(),
      emit: jest.fn()
    } as any;

    // Test DEX configurations
    testDexConfigs = [
      {
        name: 'Raydium',
        programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        instructions: {
          newPoolCreation: 'initialize2'
        },
        enabled: true,
        priority: 1
      },
      {
        name: 'Orca',
        programId: '9W959DqEETiGZocYWisQaak33tGzYcpqS6aGmJSSTpDG',
        instructions: {
          newPoolCreation: 'initializePool'
        },
        enabled: true,
        priority: 2
      },
      {
        name: 'Disabled DEX',
        programId: 'DisabledProgramId',
        instructions: {
          newPoolCreation: 'initialize'
        },
        enabled: false,
        priority: 3
      }
    ];

    // Create BlockchainWatcher instance
    blockchainWatcher = new BlockchainWatcher(
      mockConnectionManager,
      testDexConfigs,
      'finalized'
    );
  });

  afterEach(async () => {
    // Clean up
    if (blockchainWatcher.getStatus().isActive) {
      await blockchainWatcher.stop();
    }
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      const status = blockchainWatcher.getStatus();
      
      expect(status.isActive).toBe(false);
      expect(status.subscriptions).toEqual([]);
      expect(status.eventsProcessed).toBe(0);
      expect(status.errors).toBe(0);
      expect(status.lastEventTime).toBeUndefined();
    });

    it('should filter out disabled DEXes', () => {
      const watcher = new BlockchainWatcher(
        mockConnectionManager,
        testDexConfigs,
        'finalized'
      );

      // Should only have enabled DEXes
      expect(mockConnectionManager.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockConnectionManager.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
    });
  });

  describe('start', () => {
    it('should start monitoring successfully', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);

      const startedSpy = jest.fn();
      blockchainWatcher.on('started', startedSpy);

      await blockchainWatcher.start();

      const status = blockchainWatcher.getStatus();
      expect(status.isActive).toBe(true);
      expect(status.subscriptions).toEqual([mockSubId, mockSubId]); // Two enabled DEXes
      expect(mockConnection.onLogs).toHaveBeenCalledTimes(2);
      expect(startedSpy).toHaveBeenCalled();
    });

    it('should throw error if already active', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);

      await blockchainWatcher.start();

      await expect(blockchainWatcher.start()).rejects.toThrow(
        'BlockchainWatcher is already active'
      );
    });

    it('should throw error if connection not available', async () => {
      mockConnectionManager.getConnection.mockReturnValue(null as any);

      await expect(blockchainWatcher.start()).rejects.toThrow(
        'Connection not established'
      );
    });

    it('should handle subscription errors', async () => {
      mockConnection.onLogs.mockImplementation(() => {
        throw new Error('Subscription failed');
      });

      await expect(blockchainWatcher.start()).rejects.toThrow(
        'Failed to start BlockchainWatcher'
      );

      const status = blockchainWatcher.getStatus();
      expect(status.errors).toBeGreaterThan(0);
    });
  });

  describe('stop', () => {
    it('should stop monitoring and clean up subscriptions', async () => {
      const mockSubId1 = 12345;
      const mockSubId2 = 67890;
      mockConnection.onLogs
        .mockReturnValueOnce(mockSubId1)
        .mockReturnValueOnce(mockSubId2);

      const stoppedSpy = jest.fn();
      blockchainWatcher.on('stopped', stoppedSpy);

      await blockchainWatcher.start();
      await blockchainWatcher.stop();

      const status = blockchainWatcher.getStatus();
      expect(status.isActive).toBe(false);
      expect(status.subscriptions).toEqual([]);
      expect(mockConnection.removeOnLogsListener).toHaveBeenCalledWith(mockSubId1);
      expect(mockConnection.removeOnLogsListener).toHaveBeenCalledWith(mockSubId2);
      expect(stoppedSpy).toHaveBeenCalled();
    });

    it('should handle removal errors gracefully', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);
      mockConnection.removeOnLogsListener.mockRejectedValue(new Error('Removal failed'));

      const logSpy = jest.fn();
      blockchainWatcher.on('log', logSpy);

      await blockchainWatcher.start();
      await blockchainWatcher.stop();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
          message: expect.stringContaining('Failed to remove subscription')
        })
      );
    });

    it('should do nothing if not active', async () => {
      await blockchainWatcher.stop();

      expect(mockConnection.removeOnLogsListener).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    it('should pause and resume monitoring', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);

      const pausedSpy = jest.fn();
      const resumedSpy = jest.fn();
      blockchainWatcher.on('paused', pausedSpy);
      blockchainWatcher.on('resumed', resumedSpy);

      await blockchainWatcher.start();
      
      blockchainWatcher.pause();
      expect(blockchainWatcher.getStatus().isActive).toBe(false);
      expect(pausedSpy).toHaveBeenCalled();

      blockchainWatcher.resume();
      expect(blockchainWatcher.getStatus().isActive).toBe(true);
      expect(resumedSpy).toHaveBeenCalled();
    });

    it('should not resume if no subscriptions exist', async () => {
      const resumedSpy = jest.fn();
      blockchainWatcher.on('resumed', resumedSpy);

      blockchainWatcher.resume();
      
      expect(blockchainWatcher.getStatus().isActive).toBe(false);
      expect(resumedSpy).not.toHaveBeenCalled();
    });
  });

  describe('log handling', () => {
    it('should process new pool events when pool creation instruction is found', async () => {
      const mockSubId = 12345;
      let logCallbacks: any[] = [];
      const mockTransaction: ParsedTransactionWithMeta = {
        transaction: {
          message: {
            instructions: [],
            accountKeys: [
              { pubkey: new PublicKey('pool123'), signer: false, writable: true },
              { pubkey: new PublicKey('tokenA123'), signer: false, writable: true },
              { pubkey: new PublicKey('tokenB123'), signer: false, writable: true }
            ]
          },
          signatures: ['signature123']
        },
        meta: null
      } as any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallbacks.push(callback);
        return mockSubId;
      });

      mockConnection.getParsedTransaction.mockResolvedValue(mockTransaction);

      const newPoolSpy = jest.fn();
      blockchainWatcher.on('newPool', newPoolSpy);

      await blockchainWatcher.start();

      // Simulate log event with pool creation instruction for the first DEX (Raydium)
      logCallbacks[0]({
        logs: ['Program log: initialize2'],
        err: null,
        signature: 'signature123'
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockConnection.getParsedTransaction).toHaveBeenCalledWith(
        'signature123',
        {
          maxSupportedTransactionVersion: 0,
          commitment: 'finalized'
        }
      );

      expect(newPoolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          signature: 'signature123',
          dex: 'Raydium',
          poolAddress: 'pool123',
          tokenA: 'tokenA123',
          tokenB: 'tokenB123',
          timestamp: expect.any(Number)
        })
      );

      const status = blockchainWatcher.getStatus();
      expect(status.eventsProcessed).toBe(1);
      expect(status.lastEventTime).toBeDefined();
    });

    it('should ignore logs without pool creation instruction', async () => {
      const mockSubId = 12345;
      let logCallback: any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      const newPoolSpy = jest.fn();
      blockchainWatcher.on('newPool', newPoolSpy);

      await blockchainWatcher.start();

      // Simulate log event without pool creation instruction
      logCallback({
        logs: ['Program log: some other instruction'],
        err: null,
        signature: 'signature123'
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockConnection.getParsedTransaction).not.toHaveBeenCalled();
      expect(newPoolSpy).not.toHaveBeenCalled();
    });

    it('should handle log errors gracefully', async () => {
      const mockSubId = 12345;
      let logCallback: any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      const logSpy = jest.fn();
      blockchainWatcher.on('log', logSpy);

      await blockchainWatcher.start();

      // Simulate log error
      logCallback({
        logs: null,
        err: new Error('Subscription error'),
        signature: 'signature123'
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('Log subscription error')
        })
      );

      const status = blockchainWatcher.getStatus();
      expect(status.errors).toBeGreaterThan(0);
    });

    it('should ignore logs when paused', async () => {
      const mockSubId = 12345;
      let logCallback: any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      const newPoolSpy = jest.fn();
      blockchainWatcher.on('newPool', newPoolSpy);

      await blockchainWatcher.start();
      blockchainWatcher.pause();

      // Simulate log event
      logCallback({
        logs: ['Program log: initialize2'],
        err: null,
        signature: 'signature123'
      });

      expect(newPoolSpy).not.toHaveBeenCalled();
    });
  });

  describe('transaction parsing', () => {
    it('should handle transaction parsing errors gracefully', async () => {
      const mockSubId = 12345;
      let logCallback: any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      mockConnection.getParsedTransaction.mockRejectedValue(new Error('Transaction fetch failed'));

      const logSpy = jest.fn();
      blockchainWatcher.on('log', logSpy);

      await blockchainWatcher.start();

      // Simulate log event
      logCallback({
        logs: ['Program log: initialize2'],
        err: null,
        signature: 'signature123'
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('Error processing transaction')
        })
      );
    });

    it('should handle null transaction response', async () => {
      const mockSubId = 12345;
      let logCallback: any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      mockConnection.getParsedTransaction.mockResolvedValue(null);

      const logSpy = jest.fn();
      blockchainWatcher.on('log', logSpy);

      await blockchainWatcher.start();

      // Simulate log event
      logCallback({
        logs: ['Program log: initialize2'],
        err: null,
        signature: 'signature123'
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('Transaction signature123 not found')
        })
      );
    });
  });

  describe('connection event handling', () => {
    it('should handle connection restored event', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);

      await blockchainWatcher.start();

      // Simulate connection lost and restored
      const connectionEventHandler = mockConnectionManager.on.mock.calls
        .find(call => call[0] === 'connected')?.[1];

      expect(connectionEventHandler).toBeDefined();

      // Call the connection restored handler
      if (connectionEventHandler) {
        await connectionEventHandler();
      }

      // Should maintain subscriptions
      expect(blockchainWatcher.getStatus().subscriptions.length).toBeGreaterThan(0);
    });

    it('should handle connection lost event', async () => {
      const mockSubId = 12345;
      mockConnection.onLogs.mockReturnValue(mockSubId);

      await blockchainWatcher.start();

      // Simulate connection lost
      const connectionEventHandler = mockConnectionManager.on.mock.calls
        .find(call => call[0] === 'disconnected')?.[1];

      expect(connectionEventHandler).toBeDefined();

      if (connectionEventHandler) {
        await connectionEventHandler();
      }

      // Subscriptions should be cleared
      const status = blockchainWatcher.getStatus();
      expect(status.subscriptions).toEqual([]);
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      const status = blockchainWatcher.getStatus();

      expect(status).toEqual({
        isActive: false,
        subscriptions: [],
        eventsProcessed: 0,
        errors: 0,
        lastEventTime: undefined
      });
    });

    it('should return updated status after events', async () => {
      const mockSubId = 12345;
      let logCallback: any;
      const mockTransaction: ParsedTransactionWithMeta = {
        transaction: {
          message: {
            instructions: [],
            accountKeys: [
              { pubkey: new PublicKey('pool123'), signer: false, writable: true },
              { pubkey: new PublicKey('tokenA123'), signer: false, writable: true },
              { pubkey: new PublicKey('tokenB123'), signer: false, writable: true }
            ]
          },
          signatures: ['signature123']
        },
        meta: null
      } as any;

      mockConnection.onLogs.mockImplementation((programId, callback) => {
        logCallback = callback;
        return mockSubId;
      });

      mockConnection.getParsedTransaction.mockResolvedValue(mockTransaction);

      await blockchainWatcher.start();

      // Process an event
      logCallback({
        logs: ['Program log: initialize2'],
        err: null,
        signature: 'signature123'
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = blockchainWatcher.getStatus();
      expect(status.isActive).toBe(true);
      expect(status.eventsProcessed).toBe(1);
      expect(status.lastEventTime).toBeDefined();
    });
  });
});