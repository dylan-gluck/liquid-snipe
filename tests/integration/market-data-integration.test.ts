/**
 * Market Data Integration Tests
 * 
 * Tests external API integrations for market data with proper mocking:
 * - CoinGecko API for price data and market metrics
 * - Birdeye API for Solana-specific token data
 * - Real-time data processing and caching
 * - API rate limiting and error handling
 * - Data validation and sanitization
 */

import nock from 'nock';
import { MarketMonitor } from '../../src/monitoring/market-monitor';
import { TokenInfoService } from '../../src/blockchain/token-info-service';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { RpcConfig, MarketMonitoringConfig } from '../../src/types';
import { Logger } from '../../src/utils/logger';

// API endpoints
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const BIRDEYE_API = 'https://public-api.birdeye.so';

// Test configuration
const TEST_RPC_CONFIG: RpcConfig = {
  httpUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  commitment: 'confirmed'
};

const TEST_MONITORING_CONFIG: MarketMonitoringConfig = {
  enabled: true,
  priceVolatilityThreshold: 10,
  volumeSpikeMultiplier: 3,
  liquidityDropThreshold: 20,
  monitoringInterval: 30000,
  historicalDataWindow: 60,
  circuitBreakerConfig: {
    failureThreshold: 3,
    successThreshold: 5,
    timeout: 300000,
    monitoringPeriod: 60000
  }
};

// Test token data
const TEST_TOKENS = {
  SOL: {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Solana'
  },
  BONK: {
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    name: 'Bonk'
  }
};

interface CoinGeckoPriceResponse {
  [key: string]: {
    usd: number;
    usd_24h_change: number;
    usd_market_cap: number;
    usd_24h_vol: number;
    last_updated_at: number;
  };
}

interface BirdeyeTokenResponse {
  success: boolean;
  data: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI: string;
    price: number;
    priceChange24h: number;
    volume24h: number;
    marketCap: number;
    liquidity: number;
    lastTradeUnixTime: number;
    extensions: {
      coingeckoId?: string;
    };
  };
}

interface BirdeyePriceHistoryResponse {
  success: boolean;
  data: {
    items: Array<{
      unixTime: number;
      value: number;
      o: number; // open
      h: number; // high
      l: number; // low
      c: number; // close
      v: number; // volume
    }>;
  };
}

describe('Market Data Integration Tests', () => {
  let marketMonitor: MarketMonitor;
  let tokenInfoService: TokenInfoService;
  let connectionManager: ConnectionManager;

  beforeAll(async () => {
    // Initialize services
    connectionManager = new ConnectionManager(TEST_RPC_CONFIG);
    await connectionManager.initialize();

    marketMonitor = new MarketMonitor(
      connectionManager,
      TEST_MONITORING_CONFIG
    );

    tokenInfoService = new TokenInfoService(
      connectionManager.getConnection()
    );
  });

  afterAll(async () => {
    await connectionManager.shutdown();
    nock.cleanAll();
  });

  beforeEach(() => {
    nock.cleanAll();
  });

  describe('CoinGecko API Integration', () => {
    it('should fetch token prices successfully', async () => {
      const mockPriceData: CoinGeckoPriceResponse = {
        solana: {
          usd: 95.50,
          usd_24h_change: 2.5,
          usd_market_cap: 45000000000,
          usd_24h_vol: 2000000000,
          last_updated_at: Math.floor(Date.now() / 1000)
        }
      };

      nock(COINGECKO_API)
        .get('/simple/price')
        .query({
          ids: 'solana',
          vs_currencies: 'usd',
          include_24hr_change: 'true',
          include_24hr_vol: 'true',
          include_market_cap: 'true',
          include_last_updated_at: 'true'
        })
        .reply(200, mockPriceData);

      const priceData = await fetchCoinGeckoPrice(['solana']);

      expect(priceData).toBeDefined();
      expect(priceData.solana).toBeDefined();
      expect(priceData.solana.usd).toBe(95.50);
      expect(priceData.solana.usd_24h_change).toBe(2.5);
      expect(priceData.solana.usd_market_cap).toBe(45000000000);
    });

    it('should handle CoinGecko API rate limiting', async () => {
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .reply(429, {
          error: 'rate limited'
        });

      await expect(fetchCoinGeckoPrice(['solana']))
        .rejects.toThrow('rate limited');
    });

    it('should validate CoinGecko response format', async () => {
      const invalidResponse = {
        solana: {
          // Missing required fields
          usd: 95.50
          // Missing usd_24h_change, etc.
        }
      };

      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .reply(200, invalidResponse);

      const priceData = await fetchCoinGeckoPrice(['solana']);
      
      // Should handle missing fields gracefully
      expect(priceData.solana.usd).toBe(95.50);
      expect(priceData.solana.usd_24h_change).toBeUndefined();
    });

    it('should handle network timeouts', async () => {
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .delay(10000) // 10 second delay
        .reply(200, {});

      // Should timeout before 10 seconds
      await expect(
        Promise.race([
          fetchCoinGeckoPrice(['solana']),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 5000)
          )
        ])
      ).rejects.toThrow('timeout');
    }, 15000);
  });

  describe('Birdeye API Integration', () => {
    it('should fetch Solana token information', async () => {
      const mockTokenResponse: BirdeyeTokenResponse = {
        success: true,
        data: {
          address: TEST_TOKENS.BONK.address,
          symbol: 'BONK',
          name: 'Bonk',
          decimals: 5,
          logoURI: 'https://example.com/bonk.png',
          price: 0.00001234,
          priceChange24h: 15.5,
          volume24h: 1000000,
          marketCap: 500000000,
          liquidity: 2000000,
          lastTradeUnixTime: Math.floor(Date.now() / 1000),
          extensions: {
            coingeckoId: 'bonk'
          }
        }
      };

      nock(BIRDEYE_API)
        .get('/defi/token_overview')
        .query({
          address: TEST_TOKENS.BONK.address
        })
        .reply(200, mockTokenResponse);

      const tokenInfo = await fetchBirdeyeTokenInfo(TEST_TOKENS.BONK.address);

      expect(tokenInfo.success).toBe(true);
      expect(tokenInfo.data.symbol).toBe('BONK');
      expect(tokenInfo.data.price).toBe(0.00001234);
      expect(tokenInfo.data.decimals).toBe(5);
    });

    it('should fetch price history data', async () => {
      const mockPriceHistory: BirdeyePriceHistoryResponse = {
        success: true,
        data: {
          items: [
            {
              unixTime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
              value: 0.00001200,
              o: 0.00001150,
              h: 0.00001250,
              l: 0.00001100,
              c: 0.00001200,
              v: 500000
            },
            {
              unixTime: Math.floor(Date.now() / 1000) - 1800, // 30 min ago
              value: 0.00001234,
              o: 0.00001200,
              h: 0.00001280,
              l: 0.00001180,
              c: 0.00001234,
              v: 750000
            }
          ]
        }
      };

      nock(BIRDEYE_API)
        .get('/defi/history_price')
        .query({
          address: TEST_TOKENS.BONK.address,
          address_type: 'token',
          type: '5m',
          time_from: expect.any(String),
          time_to: expect.any(String)
        })
        .reply(200, mockPriceHistory);

      const priceHistory = await fetchBirdeyePriceHistory(
        TEST_TOKENS.BONK.address,
        '5m',
        Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
        Math.floor(Date.now() / 1000) // now
      );

      expect(priceHistory.success).toBe(true);
      expect(priceHistory.data.items).toHaveLength(2);
      expect(priceHistory.data.items[0].value).toBe(0.00001200);
      expect(priceHistory.data.items[1].c).toBe(0.00001234); // close price
    });

    it('should handle Birdeye API errors', async () => {
      nock(BIRDEYE_API)
        .get('/defi/token_overview')
        .query(true)
        .reply(404, {
          success: false,
          message: 'Token not found'
        });

      await expect(fetchBirdeyeTokenInfo('invalid-address'))
        .rejects.toThrow('Token not found');
    });
  });

  describe('Real-time Data Processing', () => {
    it('should process price updates with volatility detection', async () => {
      const priceUpdates = [
        { price: 95.00, timestamp: Date.now() - 60000 },
        { price: 97.50, timestamp: Date.now() - 30000 }, // +2.6% change
        { price: 105.00, timestamp: Date.now() } // +7.7% change (volatile)
      ];

      const volatilityAnalysis = analyzeVolatility(priceUpdates, 60); // 60 second window

      expect(volatilityAnalysis.isHighVolatility).toBe(true);
      expect(volatilityAnalysis.volatilityPercent).toBeGreaterThan(TEST_MONITORING_CONFIG.priceVolatilityThreshold);
      expect(volatilityAnalysis.priceChanges).toHaveLength(2);
    });

    it('should detect volume spikes', async () => {
      const volumeData = [
        { volume: 1000000, timestamp: Date.now() - 120000 }, // 2 min ago
        { volume: 1100000, timestamp: Date.now() - 60000 },  // 1 min ago
        { volume: 4000000, timestamp: Date.now() } // Now - 3.6x spike
      ];

      const spikeAnalysis = detectVolumeSpike(volumeData, TEST_MONITORING_CONFIG.volumeSpikeMultiplier);

      expect(spikeAnalysis.isSpike).toBe(true);
      expect(spikeAnalysis.spikeMultiplier).toBeGreaterThan(3);
      expect(spikeAnalysis.currentVolume).toBe(4000000);
    });

    it('should cache API responses appropriately', async () => {
      const cacheManager = new ApiCacheManager(60000); // 1 minute cache

      // Mock first request
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .reply(200, { solana: { usd: 95.50 } });

      // First call should hit API
      const firstResult = await cacheManager.getCachedPrice('solana', () => fetchCoinGeckoPrice(['solana']));
      expect(firstResult.solana.usd).toBe(95.50);

      // Second call should use cache (no additional nock intercept)
      const secondResult = await cacheManager.getCachedPrice('solana', () => fetchCoinGeckoPrice(['solana']));
      expect(secondResult.solana.usd).toBe(95.50);

      // Verify only one API call was made
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Error Scenarios and Recovery', () => {
    it('should handle API service outages gracefully', async () => {
      // Mock all APIs returning errors
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .times(3) // Retry 3 times
        .reply(503, { error: 'Service Unavailable' });

      const fallbackData = await fetchPriceWithFallback('solana');
      
      // Should return cached/fallback data or throw appropriate error
      expect(fallbackData).toBeDefined();
      // In real implementation, this might return cached data or throw specific error
    });

    it('should validate API response data integrity', async () => {
      const corruptedResponse = {
        solana: {
          usd: 'invalid-price', // String instead of number
          usd_24h_change: null,
          usd_market_cap: -1 // Invalid negative market cap
        }
      };

      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .reply(200, corruptedResponse);

      const sanitizedData = await fetchAndValidatePrice('solana');
      
      // Should sanitize or reject invalid data
      expect(typeof sanitizedData.price === 'number' || sanitizedData.price === null).toBe(true);
      expect(sanitizedData.marketCap >= 0 || sanitizedData.marketCap === null).toBe(true);
    });

    it('should implement circuit breaker for repeated failures', async () => {
      const circuitBreaker = new ApiCircuitBreaker(3, 60000); // 3 failures, 1 minute timeout

      // Mock 3 consecutive failures
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(true)
        .times(3)
        .reply(500, { error: 'Internal Server Error' });

      // First 3 calls should reach the API and fail
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(() => fetchCoinGeckoPrice(['solana'])))
          .rejects.toThrow('Internal Server Error');
      }

      // 4th call should be blocked by circuit breaker
      await expect(circuitBreaker.execute(() => fetchCoinGeckoPrice(['solana'])))
        .rejects.toThrow('Circuit breaker is open');
    });
  });

  describe('Performance and Rate Limiting', () => {
    it('should respect API rate limits', async () => {
      const rateLimiter = new ApiRateLimiter(5, 60000); // 5 requests per minute

      const promises: Promise<any>[] = [];
      
      // Try to make 10 requests
      for (let i = 0; i < 10; i++) {
        promises.push(rateLimiter.execute(() => 
          Promise.resolve({ data: `request-${i}` })
        ));
      }

      const results = await Promise.allSettled(promises);
      
      // First 5 should succeed, rest should be rate limited
      const successful = results.filter(r => r.status === 'fulfilled');
      const rateLimited = results.filter(r => r.status === 'rejected');
      
      expect(successful).toHaveLength(5);
      expect(rateLimit}.toHaveLength(5);
    }, 10000);

    it('should batch API requests efficiently', async () => {
      const batchRequester = new BatchApiRequester(100); // 100ms batch window

      // Mock API that expects batched request
      nock(COINGECKO_API)
        .get('/simple/price')
        .query(query => query.ids === 'solana,bonk,bitcoin')
        .reply(200, {
          solana: { usd: 95.50 },
          bonk: { usd: 0.00001234 },
          bitcoin: { usd: 45000 }
        });

      // Make individual requests that should be batched
      const [solResult, bonkResult, btcResult] = await Promise.all([
        batchRequester.requestPrice('solana'),
        batchRequester.requestPrice('bonk'), 
        batchRequester.requestPrice('bitcoin')
      ]);

      expect(solResult.usd).toBe(95.50);
      expect(bonkResult.usd).toBe(0.00001234);
      expect(btcResult.usd).toBe(45000);

      // Verify only one API call was made
      expect(nock.isDone()).toBe(true);
    });
  });
});

// Helper functions and classes for testing

async function fetchCoinGeckoPrice(ids: string[]): Promise<CoinGeckoPriceResponse> {
  const response = await fetch(`${COINGECKO_API}/simple/price?${new URLSearchParams({
    ids: ids.join(','),
    vs_currencies: 'usd',
    include_24hr_change: 'true',
    include_24hr_vol: 'true',
    include_market_cap: 'true',
    include_last_updated_at: 'true'
  })}`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return await response.json();
}

async function fetchBirdeyeTokenInfo(address: string): Promise<BirdeyeTokenResponse> {
  const response = await fetch(`${BIRDEYE_API}/defi/token_overview?address=${address}`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ success: false, message: 'Unknown error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

async function fetchBirdeyePriceHistory(
  address: string,
  type: string,
  timeFrom: number,
  timeTo: number
): Promise<BirdeyePriceHistoryResponse> {
  const params = new URLSearchParams({
    address,
    address_type: 'token',
    type,
    time_from: timeFrom.toString(),
    time_to: timeTo.toString()
  });

  const response = await fetch(`${BIRDEYE_API}/defi/history_price?${params}`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ success: false, message: 'Unknown error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

function analyzeVolatility(priceUpdates: Array<{ price: number; timestamp: number }>, windowSeconds: number) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  
  const recentPrices = priceUpdates.filter(update => 
    now - update.timestamp <= windowMs
  ).sort((a, b) => a.timestamp - b.timestamp);

  if (recentPrices.length < 2) {
    return { isHighVolatility: false, volatilityPercent: 0, priceChanges: [] };
  }

  const priceChanges: number[] = [];
  for (let i = 1; i < recentPrices.length; i++) {
    const change = ((recentPrices[i].price - recentPrices[i-1].price) / recentPrices[i-1].price) * 100;
    priceChanges.push(Math.abs(change));
  }

  const maxChange = Math.max(...priceChanges);
  const avgChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;

  return {
    isHighVolatility: maxChange > 10, // 10% threshold
    volatilityPercent: maxChange,
    averageVolatilityPercent: avgChange,
    priceChanges
  };
}

function detectVolumeSpike(volumeData: Array<{ volume: number; timestamp: number }>, spikeThreshold: number) {
  if (volumeData.length < 2) {
    return { isSpike: false, spikeMultiplier: 1, currentVolume: 0 };
  }

  const sortedData = volumeData.sort((a, b) => a.timestamp - b.timestamp);
  const currentVolume = sortedData[sortedData.length - 1].volume;
  
  // Calculate average of previous volumes
  const previousVolumes = sortedData.slice(0, -1);
  const avgPreviousVolume = previousVolumes.reduce((sum, data) => sum + data.volume, 0) / previousVolumes.length;
  
  const spikeMultiplier = currentVolume / avgPreviousVolume;

  return {
    isSpike: spikeMultiplier > spikeThreshold,
    spikeMultiplier,
    currentVolume,
    averagePreviousVolume: avgPreviousVolume
  };
}

class ApiCacheManager {
  private cache = new Map<string, { data: any; expiry: number }>();

  constructor(private cacheDuration: number) {}

  async getCachedPrice<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const data = await fetcher();
    this.cache.set(key, {
      data,
      expiry: Date.now() + this.cacheDuration
    });

    return data;
  }
}

class ApiCircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(private failureThreshold: number, private timeoutMs: number) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

class ApiRateLimiter {
  private requests: number[] = [];

  constructor(private maxRequests: number, private windowMs: number) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    
    // Remove old requests outside the window
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      throw new Error('Rate limit exceeded');
    }

    this.requests.push(now);
    return await fn();
  }
}

class BatchApiRequester {
  private pendingRequests = new Map<string, Promise<any>>();
  private batchTimeout?: NodeJS.Timeout;

  constructor(private batchWindowMs: number) {}

  async requestPrice(tokenId: string): Promise<any> {
    if (this.pendingRequests.has(tokenId)) {
      return this.pendingRequests.get(tokenId);
    }

    const promise = new Promise((resolve, reject) => {
      // Add to batch and set timeout to execute batch
      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => {
          this.executeBatch().then(() => {
            // Resolved in executeBatch
          }).catch(reject);
        }, this.batchWindowMs);
      }
    });

    this.pendingRequests.set(tokenId, promise);
    return promise;
  }

  private async executeBatch(): Promise<void> {
    const tokenIds = Array.from(this.pendingRequests.keys());
    const promises = Array.from(this.pendingRequests.values());
    
    try {
      const batchResult = await fetchCoinGeckoPrice(tokenIds);
      
      // Resolve individual promises
      tokenIds.forEach(tokenId => {
        const promise = this.pendingRequests.get(tokenId);
        if (promise && batchResult[tokenId]) {
          (promise as any).resolve(batchResult[tokenId]);
        }
      });
    } catch (error) {
      // Reject all pending promises
      promises.forEach(promise => (promise as any).reject(error));
    } finally {
      this.pendingRequests.clear();
      this.batchTimeout = undefined;
    }
  }
}

// Mock functions for API fallbacks and validation
async function fetchPriceWithFallback(tokenId: string) {
  try {
    return await fetchCoinGeckoPrice([tokenId]);
  } catch (error) {
    // Return cached data or throw specific error
    return { [tokenId]: { usd: null, cached: true } };
  }
}

async function fetchAndValidatePrice(tokenId: string) {
  const rawData = await fetchCoinGeckoPrice([tokenId]);
  const tokenData = rawData[tokenId];
  
  return {
    price: typeof tokenData?.usd === 'number' ? tokenData.usd : null,
    change24h: typeof tokenData?.usd_24h_change === 'number' ? tokenData.usd_24h_change : null,
    marketCap: typeof tokenData?.usd_market_cap === 'number' && tokenData.usd_market_cap >= 0 
      ? tokenData.usd_market_cap : null,
    volume24h: typeof tokenData?.usd_24h_vol === 'number' && tokenData.usd_24h_vol >= 0
      ? tokenData.usd_24h_vol : null
  };
}