import { Connection, Commitment, ConnectionConfig, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { RpcConfig } from '../types';

export interface ConnectionStatus {
  isConnected: boolean;
  lastPingTime?: number;
  pingLatency?: number;
  reconnectAttempts: number;
  lastError?: string;
}

export interface ConnectionMetrics {
  successfulRequests: number;
  failedRequests: number;
  totalReconnects: number;
  uptime: number;
  startTime: number;
}

export class ConnectionManager extends EventEmitter {
  private connection: Connection | null = null;
  private config: RpcConfig;
  private status: ConnectionStatus;
  private metrics: ConnectionMetrics;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(config: RpcConfig) {
    super();
    this.config = { ...config };
    this.status = {
      isConnected: false,
      reconnectAttempts: 0,
    };
    this.metrics = {
      successfulRequests: 0,
      failedRequests: 0,
      totalReconnects: 0,
      uptime: 0,
      startTime: Date.now(),
    };
  }

  /**
   * Initialize the connection to Solana RPC
   */
  async initialize(): Promise<void> {
    try {
      await this.connect();
      this.startHealthChecking();
      this.emit('connected', this.status);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Establish connection to Solana RPC
   */
  private async connect(): Promise<void> {
    const connectionConfig: ConnectionConfig = {
      commitment: this.config.commitment || 'confirmed',
      wsEndpoint: this.config.wsUrl,
      httpHeaders: {},
    };

    // Add connection timeout if specified
    if (this.config.connectionTimeout) {
      connectionConfig.fetch = (url, options) =>
        Promise.race([
          fetch(url, options),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), this.config.connectionTimeout)
          ),
        ]);
    }

    this.connection = new Connection(this.config.httpUrl, connectionConfig);

    // Test the connection
    await this.testConnection();

    this.status.isConnected = true;
    this.status.reconnectAttempts = 0;
    this.status.lastError = undefined;
  }

  /**
   * Test connection by fetching recent blockhash
   */
  private async testConnection(): Promise<void> {
    if (!this.connection) {
      throw new Error('Connection not initialized');
    }

    const startTime = Date.now();
    try {
      await this.connection.getLatestBlockhash();
      this.status.lastPingTime = Date.now();
      this.status.pingLatency = this.status.lastPingTime - startTime;
      this.metrics.successfulRequests++;
    } catch (error) {
      this.metrics.failedRequests++;
      throw error;
    }
  }

  /**
   * Start health checking interval
   */
  private startHealthChecking(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        await this.testConnection();
        
        if (!this.status.isConnected) {
          this.status.isConnected = true;
          this.emit('reconnected', this.status);
        }
      } catch (error) {
        if (this.status.isConnected) {
          this.status.isConnected = false;
          this.status.lastError = error instanceof Error ? error.message : 'Unknown error';
          this.emit('disconnected', this.status);
          
          // Trigger reconnection
          this.scheduleReconnection();
        }
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnection(): void {
    if (this.isShuttingDown || this.reconnectTimeout) return;

    const { maxRetries, baseDelay, maxDelay } = this.config.reconnectPolicy || {
      maxRetries: 5,
      baseDelay: 1000,
      maxDelay: 60000,
    };

    if (this.status.reconnectAttempts >= maxRetries) {
      this.emit('maxReconnectAttemptsReached', this.status);
      return;
    }

    const delay = Math.min(
      baseDelay * Math.pow(2, this.status.reconnectAttempts),
      maxDelay
    );

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      this.status.reconnectAttempts++;

      try {
        await this.connect();
        this.metrics.totalReconnects++;
        this.emit('reconnected', this.status);
      } catch (error) {
        this.status.lastError = error instanceof Error ? error.message : 'Unknown error';
        this.emit('reconnectFailed', { error, attempt: this.status.reconnectAttempts });
        
        // Schedule next attempt
        this.scheduleReconnection();
      }
    }, delay);
  }

  /**
   * Get the current Solana connection
   */
  getConnection(): Connection {
    if (!this.connection || !this.status.isConnected) {
      throw new Error('No active connection to Solana RPC');
    }
    return this.connection;
  }

  /**
   * Get connection status
   */
  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  /**
   * Get connection metrics
   */
  getMetrics(): ConnectionMetrics {
    return {
      ...this.metrics,
      uptime: this.status.isConnected ? Date.now() - this.metrics.startTime : 0,
    };
  }

  /**
   * Check if connection is healthy
   */
  isHealthy(): boolean {
    return this.status.isConnected && !!this.connection;
  }

  /**
   * Update RPC configuration
   */
  async updateConfig(newConfig: Partial<RpcConfig>): Promise<void> {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };

    // If URLs changed, reconnect
    if (
      newConfig.httpUrl && newConfig.httpUrl !== oldConfig.httpUrl ||
      newConfig.wsUrl && newConfig.wsUrl !== oldConfig.wsUrl
    ) {
      await this.reconnect();
    }

    this.emit('configUpdated', { oldConfig, newConfig: this.config });
  }

  /**
   * Force a reconnection
   */
  async reconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.status.isConnected = false;
    this.status.reconnectAttempts = 0;

    await this.connect();
    this.emit('reconnected', this.status);
  }

  /**
   * Shutdown the connection manager
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.status.isConnected = false;
    this.connection = null;

    this.emit('shutdown', {});
  }
}