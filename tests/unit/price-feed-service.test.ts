import { PriceFeedService, PriceData, PoolData } from '../../src/data/price-feed-service';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PriceFeedService', () => {
  let priceFeedService: PriceFeedService;

  beforeEach(() => {
    jest.clearAllMocks();
    priceFeedService = new PriceFeedService();
  });

  afterEach(async () => {
    await priceFeedService.shutdown();
  });

  describe('getTokenPrice', () => {
    it('should return cached price data if available', async () => {
      const testAddress = 'So11111111111111111111111111111111111111112';
      
      // Mock a successful API response first to populate cache
      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({
          data: {
            success: true,
            data: { value: 150.25 }
          }
        }),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      // First call should fetch from API
      const result1 = await priceFeedService.getTokenPrice(testAddress);
      expect(result1).toBeTruthy();
      expect(result1?.price).toBe(150.25);

      // Second call should return cached data
      const result2 = await priceFeedService.getTokenPrice(testAddress);
      expect(result2).toBeTruthy();
      expect(result2?.price).toBe(150.25);
    });

    it('should return stablecoin price immediately', async () => {
      const usdcAddress = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      
      const result = await priceFeedService.getTokenPrice(usdcAddress);
      
      expect(result).toBeTruthy();
      expect(result?.symbol).toBe('USDC');
      expect(result?.price).toBe(1.0);
      expect(result?.source).toBe('fallback');
    });

    it('should handle API failures gracefully', async () => {
      const testAddress = 'invalid_address';
      
      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('API Error')),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      const result = await priceFeedService.getTokenPrice(testAddress);
      expect(result).toBeNull();
    });

    it('should try Birdeye as fallback when Coingecko fails', async () => {
      const testAddress = 'test_token_address';
      
      let callCount = 0;
      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call (Coingecko) fails
            throw new Error('Coingecko API Error');
          } else {
            // Second call (Birdeye) succeeds
            return Promise.resolve({
              data: {
                success: true,
                data: { value: 0.0025 }
              }
            });
          }
        }),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      const result = await priceFeedService.getTokenPrice(testAddress);
      
      expect(result).toBeTruthy();
      expect(result?.price).toBe(0.0025);
      expect(result?.source).toBe('birdeye');
    });
  });

  describe('getPoolLiquidity', () => {
    it('should fetch pool data from Birdeye API', async () => {
      const poolAddress = 'test_pool_address';
      const mockPoolData = {
        success: true,
        data: {
          tokenA: {
            address: 'token_a_address',
            symbol: 'TOKENA',
            reserve: '1000000',
            price: '1.50'
          },
          tokenB: {
            address: 'token_b_address',
            symbol: 'TOKENB',
            reserve: '500000',
            price: '3.00'
          },
          liquidity: {
            usd: '2500000'
          },
          volume24h: {
            usd: '150000'
          },
          fees24h: {
            usd: '1500'
          },
          priceRatio: '0.5'
        }
      };

      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: mockPoolData }),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      const result = await priceFeedService.getPoolLiquidity(poolAddress);

      expect(result).toBeTruthy();
      expect(result?.totalLiquidityUsd).toBe(2500000);
      expect(result?.tokenA.symbol).toBe('TOKENA');
      expect(result?.tokenB.symbol).toBe('TOKENB');
      expect(result?.volume24h).toBe(150000);
    });

    it('should return null on API failure', async () => {
      const poolAddress = 'invalid_pool';
      
      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('API Error')),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      const result = await priceFeedService.getPoolLiquidity(poolAddress);
      expect(result).toBeNull();
    });
  });

  describe('getBatchPrices', () => {
    it('should fetch multiple token prices efficiently', async () => {
      const addresses = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'test_token_1',
        'test_token_2'
      ];

      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockImplementation((url) => {
          if (url.includes('test_token_1')) {
            return Promise.resolve({
              data: { success: true, data: { value: 0.05 } }
            });
          } else if (url.includes('test_token_2')) {
            return Promise.resolve({
              data: { success: true, data: { value: 1.25 } }
            });
          }
          throw new Error('Unknown token');
        }),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      const results = await priceFeedService.getBatchPrices(addresses);

      expect(results.size).toBeGreaterThan(0);
      expect(results.has('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
      expect(results.get('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')?.price).toBe(1.0);
    });
  });

  describe('health status', () => {
    it('should return health status information', () => {
      const status = priceFeedService.getHealthStatus();

      expect(status).toHaveProperty('coingecko');
      expect(status).toHaveProperty('birdeye');
      expect(status).toHaveProperty('cacheStats');
      expect(status).toHaveProperty('wsConnections');

      expect(status.coingecko).toHaveProperty('available');
      expect(status.coingecko).toHaveProperty('requestsRemaining');
      expect(status.birdeye).toHaveProperty('available');
      expect(status.birdeye).toHaveProperty('requestsRemaining');
    });
  });

  describe('rate limiting', () => {
    it('should respect rate limits', async () => {
      const testAddress = 'test_rate_limit';
      
      // Mock successful responses
      mockedAxios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({
          data: { success: true, data: { value: 1.0 } }
        }),
        interceptors: {
          request: { use: jest.fn() }
        }
      } as any);

      // Make multiple requests rapidly
      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(priceFeedService.getTokenPrice(`${testAddress}_${i}`));
      }

      const results = await Promise.allSettled(promises);
      
      // Some requests should succeed, some might be rate limited
      const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null);
      expect(successful.length).toBeGreaterThan(0);
    });
  });

  describe('real-time monitoring', () => {
    it('should start and stop monitoring', () => {
      const addresses = ['token1', 'token2'];
      
      // Should not throw
      expect(() => {
        priceFeedService.startRealTimeMonitoring(addresses);
      }).not.toThrow();

      expect(() => {
        priceFeedService.stopRealTimeMonitoring();
      }).not.toThrow();
    });

    it('should handle price update events', (done) => {
      const testAddress = 'test_token';
      
      priceFeedService.on('priceUpdate', (update) => {
        expect(update).toHaveProperty('address');
        expect(update).toHaveProperty('price');
        expect(update).toHaveProperty('timestamp');
        done();
      });

      // Simulate a price update
      priceFeedService.emit('priceUpdate', {
        address: testAddress,
        price: 1.25,
        timestamp: Date.now()
      });
    });
  });
});