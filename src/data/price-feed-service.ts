import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';

/**
 * Price data from external APIs
 */
export interface PriceData {
  address: string;
  symbol?: string;
  price: number;
  volume24h?: number;
  marketCap?: number;
  priceChange24h?: number;
  timestamp: number;
  source: 'coingecko' | 'birdeye' | 'fallback';
}

/**
 * Liquidity pool data from Birdeye API
 */
export interface PoolData {
  poolAddress: string;
  tokenA: {
    address: string;
    symbol?: string;
    reserve: number;
    price?: number;
  };
  tokenB: {
    address: string;
    symbol?: string;
    reserve: number;
    price?: number;
  };
  totalLiquidityUsd: number;
  volume24h: number;
  fees24h: number;
  priceRatio: number;
  timestamp: number;
}

/**
 * WebSocket price update event
 */
export interface PriceUpdateEvent {
  address: string;
  price: number;
  volume?: number;
  timestamp: number;
}

/**
 * Cache entry for price data
 */
interface PriceCacheEntry {
  data: PriceData;
  expiry: number;
}

/**
 * Cache entry for pool data
 */
interface PoolCacheEntry {
  data: PoolData;
  expiry: number;
}

/**
 * Rate limiting configuration
 */
interface RateLimit {
  requests: number;
  windowMs: number;
  current: number;
  windowStart: number;
}

/**
 * Real-time price feed service integrating multiple data sources
 */
export class PriceFeedService extends EventEmitter {
  private logger: Logger;
  private coingeckoClient: AxiosInstance;
  private birdeyeClient: AxiosInstance;
  private priceCache: Map<string, PriceCacheEntry> = new Map();
  private poolCache: Map<string, PoolCacheEntry> = new Map();
  private wsConnections: Map<string, WebSocket> = new Map();
  private rateLimits: Map<string, RateLimit> = new Map();
  
  // Cache configuration
  private readonly priceCacheExpiryMs = 30 * 1000; // 30 seconds
  private readonly poolCacheExpiryMs = 60 * 1000; // 60 seconds
  
  // Rate limiting configuration
  private readonly coingeckoRateLimit = { requests: 10, windowMs: 60000 }; // 10 requests per minute
  private readonly birdeyeRateLimit = { requests: 100, windowMs: 60000 }; // 100 requests per minute
  
  // Known stablecoin addresses for fallback pricing
  private readonly stablecoins = new Map([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { symbol: 'USDC', price: 1.0 }],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', { symbol: 'USDT', price: 1.0 }],
    ['So11111111111111111111111111111111111111112', { symbol: 'SOL', price: 0 }], // SOL price will be fetched
  ]);

  constructor() {
    super();
    this.logger = new Logger('PriceFeedService');

    // Initialize HTTP clients
    this.coingeckoClient = axios.create({
      baseURL: 'https://api.coingecko.com/api/v3',
      timeout: 10000,
      headers: {
        'User-Agent': 'liquid-snipe/1.0.0',
        'Accept': 'application/json',
      },
    });

    this.birdeyeClient = axios.create({
      baseURL: 'https://public-api.birdeye.so',
      timeout: 10000,
      headers: {
        'X-API-KEY': process.env.BIRDEYE_API_KEY || '',
        'Accept': 'application/json',
      },
    });

    // Initialize rate limits
    this.initializeRateLimits();

    // Setup request interceptors for rate limiting
    this.setupRequestInterceptors();

    // Start cache cleanup
    this.startCacheCleanup();

    this.logger.info('PriceFeedService initialized');
  }

  /**
   * Get current price for a token
   */
  public async getTokenPrice(address: string, symbol?: string): Promise<PriceData | null> {
    try {
      // Check cache first
      const cached = this.getCachedPrice(address);
      if (cached) {
        this.logger.debug(`Retrieved cached price for ${address}: $${cached.price}`);
        return cached;
      }

      // Check if it's a known stablecoin
      const stablecoin = this.stablecoins.get(address);
      if (stablecoin && stablecoin.symbol !== 'SOL') {
        const priceData: PriceData = {
          address,
          symbol: stablecoin.symbol,
          price: stablecoin.price,
          timestamp: Date.now(),
          source: 'fallback',
        };
        this.setCachedPrice(address, priceData);
        return priceData;
      }

      // Try Coingecko first (more reliable for major tokens)
      let priceData = await this.fetchFromCoingecko(address, symbol);
      
      // Fallback to Birdeye for Solana-specific tokens
      if (!priceData) {
        priceData = await this.fetchFromBirdeye(address);
      }

      if (priceData) {
        this.setCachedPrice(address, priceData);
        this.emit('priceUpdate', { address, price: priceData.price, timestamp: priceData.timestamp });
      }

      return priceData;
    } catch (error) {
      this.logger.error(`Failed to get token price for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get comprehensive pool liquidity data
   */
  public async getPoolLiquidity(poolAddress: string): Promise<PoolData | null> {
    try {
      // Check cache first
      const cached = this.getCachedPoolData(poolAddress);
      if (cached) {
        this.logger.debug(`Retrieved cached pool data for ${poolAddress}`);
        return cached;
      }

      // Fetch from Birdeye (primary source for Solana pool data)
      const poolData = await this.fetchPoolDataFromBirdeye(poolAddress);

      if (poolData) {
        this.setCachedPoolData(poolAddress, poolData);
        this.emit('poolUpdate', poolData);
      }

      return poolData;
    } catch (error) {
      this.logger.error(`Failed to get pool liquidity for ${poolAddress}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Start real-time price monitoring for specific tokens
   */
  public startRealTimeMonitoring(addresses: string[]): void {
    addresses.forEach(address => {
      this.setupWebSocketConnection(address);
    });
  }

  /**
   * Stop real-time monitoring
   */
  public stopRealTimeMonitoring(address?: string): void {
    if (address) {
      const ws = this.wsConnections.get(address);
      if (ws) {
        ws.close();
        this.wsConnections.delete(address);
      }
    } else {
      // Stop all connections
      this.wsConnections.forEach((ws) => ws.close());
      this.wsConnections.clear();
    }
  }

  /**
   * Get multiple token prices in batch
   */
  public async getBatchPrices(addresses: string[]): Promise<Map<string, PriceData>> {
    const results = new Map<string, PriceData>();
    
    // Process in batches to respect rate limits
    const batchSize = 10;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const promises = batch.map(address => this.getTokenPrice(address));
      
      const batchResults = await Promise.allSettled(promises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          results.set(batch[index], result.value);
        }
      });

      // Small delay between batches
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  /**
   * Fetch price data from Coingecko
   */
  private async fetchFromCoingecko(address: string, symbol?: string): Promise<PriceData | null> {
    try {
      if (!this.canMakeRequest('coingecko')) {
        this.logger.debug('Coingecko rate limit exceeded, skipping');
        return null;
      }

      let endpoint = '';
      let params: any = {};

      // Try different endpoints based on available data
      if (symbol) {
        // Search by symbol first
        endpoint = '/coins/markets';
        params = {
          vs_currency: 'usd',
          ids: symbol.toLowerCase(),
          order: 'market_cap_desc',
          per_page: 1,
          page: 1,
        };
      } else {
        // Search by contract address
        endpoint = '/coins/solana/contract/' + address;
      }

      const response = await this.coingeckoClient.get(endpoint, { params });
      const data = response.data;

      if (Array.isArray(data) && data.length > 0) {
        const coin = data[0];
        return {
          address,
          symbol: coin.symbol?.toUpperCase(),
          price: coin.current_price || 0,
          volume24h: coin.total_volume,
          marketCap: coin.market_cap,
          priceChange24h: coin.price_change_percentage_24h,
          timestamp: Date.now(),
          source: 'coingecko',
        };
      } else if (data.market_data) {
        // Single coin response
        return {
          address,
          symbol: data.symbol?.toUpperCase(),
          price: data.market_data.current_price?.usd || 0,
          volume24h: data.market_data.total_volume?.usd,
          marketCap: data.market_data.market_cap?.usd,
          priceChange24h: data.market_data.price_change_percentage_24h,
          timestamp: Date.now(),
          source: 'coingecko',
        };
      }

      return null;
    } catch (error) {
      this.logger.debug(`Coingecko fetch failed for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetch price data from Birdeye
   */
  private async fetchFromBirdeye(address: string): Promise<PriceData | null> {
    try {
      if (!this.canMakeRequest('birdeye')) {
        this.logger.debug('Birdeye rate limit exceeded, skipping');
        return null;
      }

      const response = await this.birdeyeClient.get(`/defi/price?address=${address}`);
      const data = response.data;

      if (data.success && data.data) {
        return {
          address,
          price: data.data.value || 0,
          timestamp: Date.now(),
          source: 'birdeye',
        };
      }

      return null;
    } catch (error) {
      this.logger.debug(`Birdeye price fetch failed for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetch pool data from Birdeye
   */
  private async fetchPoolDataFromBirdeye(poolAddress: string): Promise<PoolData | null> {
    try {
      if (!this.canMakeRequest('birdeye')) {
        return null;
      }

      const response = await this.birdeyeClient.get(`/defi/pool?address=${poolAddress}`);
      const data = response.data;

      if (data.success && data.data) {
        const pool = data.data;
        
        return {
          poolAddress,
          tokenA: {
            address: pool.tokenA?.address || '',
            symbol: pool.tokenA?.symbol,
            reserve: parseFloat(pool.tokenA?.reserve || '0'),
            price: parseFloat(pool.tokenA?.price || '0'),
          },
          tokenB: {
            address: pool.tokenB?.address || '',
            symbol: pool.tokenB?.symbol,
            reserve: parseFloat(pool.tokenB?.reserve || '0'),
            price: parseFloat(pool.tokenB?.price || '0'),
          },
          totalLiquidityUsd: parseFloat(pool.liquidity?.usd || '0'),
          volume24h: parseFloat(pool.volume24h?.usd || '0'),
          fees24h: parseFloat(pool.fees24h?.usd || '0'),
          priceRatio: parseFloat(pool.priceRatio || '0'),
          timestamp: Date.now(),
        };
      }

      return null;
    } catch (error) {
      this.logger.debug(`Birdeye pool fetch failed for ${poolAddress}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Setup WebSocket connection for real-time updates
   */
  private setupWebSocketConnection(address: string): void {
    try {
      // Note: This is a placeholder for WebSocket implementation
      // Real implementation would depend on the specific WebSocket API available
      const wsUrl = `wss://ws.birdeye.so/token/${address}`;
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        this.logger.debug(`WebSocket connected for ${address}`);
        // Subscribe to price updates
        ws.send(JSON.stringify({
          method: 'subscribe',
          params: ['priceUpdate', address]
        }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'priceUpdate') {
            this.handleWebSocketPriceUpdate(address, message.data);
          }
        } catch (error) {
          this.logger.error('Failed to parse WebSocket message', { error });
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`WebSocket error for ${address}`, { error });
      });

      ws.on('close', () => {
        this.logger.debug(`WebSocket closed for ${address}`);
        this.wsConnections.delete(address);
        
        // Reconnect after delay
        setTimeout(() => {
          if (!this.wsConnections.has(address)) {
            this.setupWebSocketConnection(address);
          }
        }, 5000);
      });

      this.wsConnections.set(address, ws);
    } catch (error) {
      this.logger.error(`Failed to setup WebSocket for ${address}`, { error });
    }
  }

  /**
   * Handle WebSocket price updates
   */
  private handleWebSocketPriceUpdate(address: string, data: any): void {
    try {
      const priceData: PriceData = {
        address,
        price: parseFloat(data.price || '0'),
        volume24h: parseFloat(data.volume || '0'),
        timestamp: Date.now(),
        source: 'birdeye',
      };

      // Update cache
      this.setCachedPrice(address, priceData);

      // Emit update event
      this.emit('priceUpdate', {
        address,
        price: priceData.price,
        volume: priceData.volume24h,
        timestamp: priceData.timestamp,
      });
    } catch (error) {
      this.logger.error(`Failed to handle WebSocket price update for ${address}`, { error });
    }
  }

  /**
   * Initialize rate limiting
   */
  private initializeRateLimits(): void {
    this.rateLimits.set('coingecko', {
      requests: this.coingeckoRateLimit.requests,
      windowMs: this.coingeckoRateLimit.windowMs,
      current: 0,
      windowStart: Date.now(),
    });

    this.rateLimits.set('birdeye', {
      requests: this.birdeyeRateLimit.requests,
      windowMs: this.birdeyeRateLimit.windowMs,
      current: 0,
      windowStart: Date.now(),
    });
  }

  /**
   * Check if we can make a request to a service
   */
  private canMakeRequest(service: 'coingecko' | 'birdeye'): boolean {
    const rateLimit = this.rateLimits.get(service);
    if (!rateLimit) return false;

    const now = Date.now();
    
    // Reset window if expired
    if (now - rateLimit.windowStart >= rateLimit.windowMs) {
      rateLimit.current = 0;
      rateLimit.windowStart = now;
    }

    return rateLimit.current < rateLimit.requests;
  }

  /**
   * Record a request for rate limiting
   */
  private recordRequest(service: 'coingecko' | 'birdeye'): void {
    const rateLimit = this.rateLimits.get(service);
    if (rateLimit) {
      rateLimit.current++;
    }
  }

  /**
   * Setup request interceptors for rate limiting
   */
  private setupRequestInterceptors(): void {
    this.coingeckoClient.interceptors.request.use((config) => {
      this.recordRequest('coingecko');
      return config;
    });

    this.birdeyeClient.interceptors.request.use((config) => {
      this.recordRequest('birdeye');
      return config;
    });
  }

  /**
   * Get cached price data
   */
  private getCachedPrice(address: string): PriceData | null {
    const entry = this.priceCache.get(address);
    if (entry && entry.expiry > Date.now()) {
      return entry.data;
    }
    
    if (entry) {
      this.priceCache.delete(address);
    }
    
    return null;
  }

  /**
   * Set cached price data
   */
  private setCachedPrice(address: string, data: PriceData): void {
    this.priceCache.set(address, {
      data,
      expiry: Date.now() + this.priceCacheExpiryMs,
    });
  }

  /**
   * Get cached pool data
   */
  private getCachedPoolData(poolAddress: string): PoolData | null {
    const entry = this.poolCache.get(poolAddress);
    if (entry && entry.expiry > Date.now()) {
      return entry.data;
    }
    
    if (entry) {
      this.poolCache.delete(poolAddress);
    }
    
    return null;
  }

  /**
   * Set cached pool data
   */
  private setCachedPoolData(poolAddress: string, data: PoolData): void {
    this.poolCache.set(poolAddress, {
      data,
      expiry: Date.now() + this.poolCacheExpiryMs,
    });
  }

  /**
   * Start periodic cache cleanup
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000); // Cleanup every minute
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    
    // Clean price cache
    for (const [key, entry] of this.priceCache.entries()) {
      if (entry.expiry < now) {
        this.priceCache.delete(key);
      }
    }

    // Clean pool cache
    for (const [key, entry] of this.poolCache.entries()) {
      if (entry.expiry < now) {
        this.poolCache.delete(key);
      }
    }
  }

  /**
   * Get service health status
   */
  public getHealthStatus(): {
    coingecko: { available: boolean; requestsRemaining: number };
    birdeye: { available: boolean; requestsRemaining: number };
    cacheStats: {
      priceEntries: number;
      poolEntries: number;
    };
    wsConnections: number;
  } {
    const coingeckoLimit = this.rateLimits.get('coingecko')!;
    const birdeyeLimit = this.rateLimits.get('birdeye')!;

    return {
      coingecko: {
        available: this.canMakeRequest('coingecko'),
        requestsRemaining: Math.max(0, coingeckoLimit.requests - coingeckoLimit.current),
      },
      birdeye: {
        available: this.canMakeRequest('birdeye'),
        requestsRemaining: Math.max(0, birdeyeLimit.requests - birdeyeLimit.current),
      },
      cacheStats: {
        priceEntries: this.priceCache.size,
        poolEntries: this.poolCache.size,
      },
      wsConnections: this.wsConnections.size,
    };
  }

  /**
   * Shutdown service
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down PriceFeedService');
    
    // Close all WebSocket connections
    this.stopRealTimeMonitoring();
    
    // Clear caches
    this.priceCache.clear();
    this.poolCache.clear();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}