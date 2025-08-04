import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { RpcConfig } from '../../src/types';

describe('ConnectionManager - Basic Tests', () => {
  let mockConfig: RpcConfig;
  let connectionManager: ConnectionManager;

  beforeEach(() => {
    mockConfig = {
      httpUrl: 'https://api.testnet.solana.com',
      wsUrl: 'wss://api.testnet.solana.com',
      connectionTimeout: 5000,
      commitment: 'confirmed',
      reconnectPolicy: {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000,
      },
    };

    connectionManager = new ConnectionManager(mockConfig);
  });

  afterEach(async () => {
    await connectionManager.shutdown();
  });

  describe('constructor and basic methods', () => {
    it('should create a connection manager with correct configuration', () => {
      expect(connectionManager).toBeInstanceOf(ConnectionManager);
      expect(connectionManager.getStatus().isConnected).toBe(false);
      expect(connectionManager.getStatus().reconnectAttempts).toBe(0);
    });

    it('should return correct initial status', () => {
      const status = connectionManager.getStatus();
      
      expect(status.isConnected).toBe(false);
      expect(status.reconnectAttempts).toBe(0);
      expect(status.lastPingTime).toBeUndefined();
      expect(status.pingLatency).toBeUndefined();
      expect(status.lastError).toBeUndefined();
    });

    it('should return correct initial metrics', () => {
      const metrics = connectionManager.getMetrics();
      
      expect(metrics.successfulRequests).toBe(0);
      expect(metrics.failedRequests).toBe(0);
      expect(metrics.totalReconnects).toBe(0);
      expect(metrics.startTime).toBeDefined();
      expect(metrics.uptime).toBe(0);
    });

    it('should report unhealthy connection initially', () => {
      expect(connectionManager.isHealthy()).toBe(false);
    });

    it('should throw error when trying to get connection before initialization', () => {
      expect(() => connectionManager.getConnection()).toThrow(
        'No active connection to Solana RPC'
      );
    });
  });

  describe('configuration updates', () => {
    it('should allow configuration updates', async () => {
      const configUpdatedSpy = jest.fn();
      connectionManager.on('configUpdated', configUpdatedSpy);

      const newConfig = {
        connectionTimeout: 10000,
      };

      await connectionManager.updateConfig(newConfig);

      expect(configUpdatedSpy).toHaveBeenCalledWith({
        oldConfig: mockConfig,
        newConfig: expect.objectContaining({
          ...mockConfig,
          connectionTimeout: 10000,
        }),
      });
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const shutdownSpy = jest.fn();
      connectionManager.on('shutdown', shutdownSpy);

      await connectionManager.shutdown();

      expect(shutdownSpy).toHaveBeenCalled();
      expect(connectionManager.getStatus().isConnected).toBe(false);
      expect(() => connectionManager.getConnection()).toThrow();
    });

    it('should prevent further operations after shutdown', async () => {
      await connectionManager.shutdown();

      expect(() => connectionManager.getConnection()).toThrow();
      expect(connectionManager.isHealthy()).toBe(false);
    });
  });

  describe('event handling', () => {
    it('should be able to register event listeners', () => {
      const connectedSpy = jest.fn();
      const disconnectedSpy = jest.fn();
      const errorSpy = jest.fn();

      connectionManager.on('connected', connectedSpy);
      connectionManager.on('disconnected', disconnectedSpy);
      connectionManager.on('error', errorSpy);

      // Just verify that listeners can be registered without throwing
      expect(connectionManager.listenerCount('connected')).toBe(1);
      expect(connectionManager.listenerCount('disconnected')).toBe(1);
      expect(connectionManager.listenerCount('error')).toBe(1);
    });
  });
});