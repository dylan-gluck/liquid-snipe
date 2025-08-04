import { TokenInfoService, TokenInfo, RiskAssessment } from '../../src/blockchain/token-info-service';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { DatabaseManager } from '../../src/db';
import { Token } from '../../src/types';
import { Connection, PublicKey } from '@solana/web3.js';

// Mock the dependencies
jest.mock('../../src/blockchain/connection-manager');
jest.mock('../../src/db');
jest.mock('@solana/web3.js');

describe('TokenInfoService', () => {
  let tokenInfoService: TokenInfoService;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let mockDbManager: jest.Mocked<DatabaseManager>;
  let mockConnection: jest.Mocked<Connection>;

  const mockTokenAddress = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Create mock instances
    mockConnection = {
      getParsedAccountInfo: jest.fn(),
      getTokenSupply: jest.fn(),
      getProgramAccounts: jest.fn(),
      getAccountInfo: jest.fn(),
    } as any;

    mockConnectionManager = {
      getConnection: jest.fn().mockReturnValue(mockConnection),
    } as any;

    mockDbManager = {
      getToken: jest.fn(),
      addToken: jest.fn(),
    } as any;

    // Create service instance
    tokenInfoService = new TokenInfoService(
      mockConnectionManager,
      mockDbManager,
      { cacheExpiryMinutes: 30 }
    );
  });

  describe('calculateRiskScore', () => {
    it('should calculate low risk score for established token', () => {
      const tokenInfo: Partial<TokenInfo> = {
        supply: 1000000, // Reasonable supply
        topHolderPercentage: 5, // Well distributed
        age: 7 * 24 * 60 * 60 * 1000, // 7 days old
        symbol: 'TEST',
        name: 'Test Token',
        isVerified: true,
      };

      const result = tokenInfoService.calculateRiskScore(tokenInfo);

      expect(result.score).toBe(0); // Low risk
      expect(result.warnings).toHaveLength(0);
      expect(result.factors.supply).toBe(0);
      expect(result.factors.holderDistribution).toBe(0);
      expect(result.factors.age).toBe(0);
      expect(result.factors.metadata).toBe(0);
      expect(result.factors.verification).toBe(0);
    });

    it('should calculate high risk score for suspicious token', () => {
      const tokenInfo: Partial<TokenInfo> = {
        supply: 1e15, // Extremely high supply
        topHolderPercentage: 80, // High concentration
        age: 30 * 60 * 1000, // 30 minutes old
        symbol: undefined, // Missing symbol
        name: undefined, // Missing name
        isVerified: false,
      };

      const result = tokenInfoService.calculateRiskScore(tokenInfo);

      expect(result.score).toBeGreaterThan(5); // High risk
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.factors.supply).toBe(2);
      expect(result.factors.holderDistribution).toBe(3);
      expect(result.factors.age).toBe(2);
      expect(result.factors.metadata).toBe(2);
      expect(result.factors.verification).toBe(1);
    });

    it('should handle partial token information', () => {
      const tokenInfo: Partial<TokenInfo> = {
        symbol: 'PARTIAL',
        name: 'Partial Token',
      };

      const result = tokenInfoService.calculateRiskScore(tokenInfo);

      expect(result.score).toBeGreaterThan(0);
      expect(result.warnings).toContain('Supply information unavailable');
      expect(result.warnings).toContain('Holder distribution unknown');
      expect(result.warnings).toContain('Token age unknown');
    });

    it('should assign appropriate risk levels for different supply sizes', () => {
      const lowSupply = tokenInfoService.calculateRiskScore({ supply: 1000000 });
      const mediumSupply = tokenInfoService.calculateRiskScore({ supply: 1e10 });
      const highSupply = tokenInfoService.calculateRiskScore({ supply: 1e15 });

      expect(lowSupply.factors.supply).toBe(0);
      expect(mediumSupply.factors.supply).toBe(1);
      expect(highSupply.factors.supply).toBe(2);
    });

    it('should assess holder concentration risk correctly', () => {
      const wellDistributed = tokenInfoService.calculateRiskScore({ topHolderPercentage: 5 });
      const someConcentration = tokenInfoService.calculateRiskScore({ topHolderPercentage: 15 });
      const mediumConcentration = tokenInfoService.calculateRiskScore({ topHolderPercentage: 30 });
      const highConcentration = tokenInfoService.calculateRiskScore({ topHolderPercentage: 80 });

      expect(wellDistributed.factors.holderDistribution).toBe(0);
      expect(someConcentration.factors.holderDistribution).toBe(1);
      expect(mediumConcentration.factors.holderDistribution).toBe(2);
      expect(highConcentration.factors.holderDistribution).toBe(3);
    });

    it('should assess age risk correctly', () => {
      const oldToken = tokenInfoService.calculateRiskScore({ 
        age: 7 * 24 * 60 * 60 * 1000 // 7 days 
      });
      const dayOldToken = tokenInfoService.calculateRiskScore({ 
        age: 12 * 60 * 60 * 1000 // 12 hours 
      });
      const veryNewToken = tokenInfoService.calculateRiskScore({ 
        age: 30 * 60 * 1000 // 30 minutes 
      });

      expect(oldToken.factors.age).toBe(0);
      expect(dayOldToken.factors.age).toBe(1);
      expect(veryNewToken.factors.age).toBe(2);
    });
  });

  describe('isNewToken', () => {
    it('should identify new token when paired with stablecoin', () => {
      const stablecoinInfo: TokenInfo = {
        address: 'usdc-address',
        symbol: 'USDC',
        name: 'USD Coin',
        riskScore: 0,
        age: 365 * 24 * 60 * 60 * 1000, // 1 year old
        isVerified: true,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const newTokenInfo: TokenInfo = {
        address: 'new-token-address',
        symbol: 'NEW',
        name: 'New Token',
        riskScore: 5,
        age: 60 * 60 * 1000, // 1 hour old
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const result = tokenInfoService.isNewToken(stablecoinInfo, newTokenInfo);

      expect(result).toBe(newTokenInfo);
    });

    it('should identify new token when SOL is the base', () => {
      const solInfo: TokenInfo = {
        address: 'sol-address',
        symbol: 'SOL',
        name: 'Solana',
        riskScore: 0,
        age: 365 * 24 * 60 * 60 * 1000,
        isVerified: true,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const newTokenInfo: TokenInfo = {
        address: 'new-token-address',
        symbol: 'NEW',
        name: 'New Token',
        riskScore: 3,
        age: 2 * 60 * 60 * 1000, // 2 hours old
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const result = tokenInfoService.isNewToken(newTokenInfo, solInfo);

      expect(result).toBe(newTokenInfo);
    });

    it('should use age as tiebreaker when both tokens are unknown', () => {
      const olderToken: TokenInfo = {
        address: 'older-token',
        symbol: 'OLD',
        name: 'Older Token',
        riskScore: 4,
        age: 24 * 60 * 60 * 1000, // 1 day old
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const newerToken: TokenInfo = {
        address: 'newer-token',
        symbol: 'NEW',
        name: 'Newer Token',
        riskScore: 4,
        age: 2 * 60 * 60 * 1000, // 2 hours old
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const result = tokenInfoService.isNewToken(olderToken, newerToken);

      expect(result).toBe(newerToken);
    });

    it('should use risk score as fallback when age is unavailable', () => {
      const lowerRiskToken: TokenInfo = {
        address: 'lower-risk-token',
        symbol: 'LOW',
        name: 'Lower Risk Token',
        riskScore: 2,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const higherRiskToken: TokenInfo = {
        address: 'higher-risk-token',
        symbol: 'HIGH',
        name: 'Higher Risk Token',
        riskScore: 6,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const result = tokenInfoService.isNewToken(lowerRiskToken, higherRiskToken);

      expect(result).toBe(higherRiskToken);
    });

    it('should handle WSOL correctly', () => {
      const wsolInfo: TokenInfo = {
        address: 'wsol-address',
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        riskScore: 0,
        age: 365 * 24 * 60 * 60 * 1000,
        isVerified: true,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const newTokenInfo: TokenInfo = {
        address: 'new-token-address',
        symbol: 'MEME',
        name: 'Meme Token',
        riskScore: 5,
        age: 30 * 60 * 1000, // 30 minutes old
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      const result = tokenInfoService.isNewToken(wsolInfo, newTokenInfo);

      expect(result).toBe(newTokenInfo);
    });
  });

  describe('fetchOnChainMetadata', () => {
    it('should handle successful metadata fetch', async () => {
      const mockMintInfo = {
        context: { slot: 123456 },
        value: {
          data: {
            parsed: {
              info: {
                decimals: 9,
                supply: '1000000000',
                mintAuthority: null,
                freezeAuthority: null,
              },
            },
            program: 'spl-token',
            space: 82,
          },
          executable: false,
          lamports: 1000000,
          owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          rentEpoch: 200,
        },
      };

      mockConnection.getParsedAccountInfo.mockResolvedValue(mockMintInfo);
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const result = await tokenInfoService.fetchOnChainMetadata(mockTokenAddress);

      expect(result.decimals).toBe(9);
      expect(result.metadata?.supply).toBe('1000000000');
    });

    it('should handle missing mint data', async () => {
      mockConnection.getParsedAccountInfo.mockResolvedValue({
        context: { slot: 123456 },
        value: null,
      });

      const result = await tokenInfoService.fetchOnChainMetadata(mockTokenAddress);

      expect(result).toEqual({});
    });

    it('should handle connection errors', async () => {
      mockConnection.getParsedAccountInfo.mockRejectedValue(new Error('Connection failed'));

      const result = await tokenInfoService.fetchOnChainMetadata(mockTokenAddress);

      expect(result).toEqual({});
    });
  });

  describe('getSupplyInfo', () => {
    it('should fetch token supply successfully', async () => {
      const mockSupply = {
        context: { slot: 123456 },
        value: {
          amount: '1000000000',
          decimals: 9,
          uiAmount: 1,
          uiAmountString: '1',
        },
      };

      mockConnection.getTokenSupply.mockResolvedValue(mockSupply);

      const result = await tokenInfoService.getSupplyInfo(mockTokenAddress);

      expect(result).toEqual({
        totalSupply: 1000000000,
        circulatingSupply: 1000000000,
      });
    });

    it('should handle connection errors', async () => {
      mockConnection.getTokenSupply.mockRejectedValue(new Error('Connection failed'));

      const result = await tokenInfoService.getSupplyInfo(mockTokenAddress);

      expect(result).toBeNull();
    });
  });

  describe('getTokenInfo', () => {
    it('should return cached info when available', async () => {
      const cachedInfo: TokenInfo = {
        address: mockTokenAddress,
        symbol: 'CACHED',
        name: 'Cached Token',
        riskScore: 2,
        age: 60 * 60 * 1000,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      // Set cache manually
      (tokenInfoService as any).setCachedTokenInfo(mockTokenAddress, cachedInfo);

      const result = await tokenInfoService.getTokenInfo(mockTokenAddress);

      expect(result).toEqual(cachedInfo);
      expect(mockDbManager.getToken).not.toHaveBeenCalled();
    });

    it('should fetch from database when cache is empty', async () => {
      const dbToken: Token = {
        address: mockTokenAddress,
        symbol: 'DB',
        name: 'Database Token',
        decimals: 9,
        firstSeen: Date.now() - 10 * 60 * 1000, // 10 minutes ago (fresh)
        isVerified: false,
        metadata: { riskScore: 3 },
      };

      mockDbManager.getToken.mockResolvedValue(dbToken);

      const result = await tokenInfoService.getTokenInfo(mockTokenAddress);

      expect(result?.symbol).toBe('DB');
      expect(result?.name).toBe('Database Token');
      expect(mockDbManager.getToken).toHaveBeenCalledWith(mockTokenAddress);
    });

    it('should return null when all sources fail', async () => {
      mockDbManager.getToken.mockResolvedValue(null);
      mockConnection.getParsedAccountInfo.mockRejectedValue(new Error('Failed'));

      const result = await tokenInfoService.getTokenInfo(mockTokenAddress);

      expect(result).toBeNull();
    });
  });

  describe('caching', () => {
    it('should cache results after fetching', async () => {
      mockDbManager.getToken.mockResolvedValue(null);

      // Mock successful blockchain responses  
      mockConnection.getParsedAccountInfo.mockResolvedValue({
        context: { slot: 123456 },
        value: {
          data: {
            parsed: { info: { decimals: 9, supply: '1000', mintAuthority: null, freezeAuthority: null } },
            program: 'spl-token',
            space: 82,
          },
          executable: false,
          lamports: 1000000,
          owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          rentEpoch: 200,
        },
      });

      mockConnection.getTokenSupply.mockResolvedValue({
        context: { slot: 123456 },
        value: { amount: '1000', decimals: 9, uiAmount: 1, uiAmountString: '1' },
      });

      mockConnection.getProgramAccounts.mockResolvedValue([]);
      mockConnection.getAccountInfo.mockResolvedValue(null);

      // First call
      const result1 = await tokenInfoService.getTokenInfo(mockTokenAddress);
      expect(result1).not.toBeNull();

      // Clear mocks to ensure cache is used
      jest.clearAllMocks();

      // Second call should use cache
      const result2 = await tokenInfoService.getTokenInfo(mockTokenAddress);
      expect(result2).toEqual(result1);
      expect(mockConnection.getParsedAccountInfo).not.toHaveBeenCalled();
    });

    it('should clear expired cache entries', () => {
      const service = new TokenInfoService(
        mockConnectionManager,
        mockDbManager,
        { cacheExpiryMinutes: 0.001 } // Very short expiry
      );

      const tokenInfo: TokenInfo = {
        address: mockTokenAddress,
        symbol: 'EXPIRE',
        name: 'Expire Token',
        riskScore: 2,
        age: 60 * 60 * 1000,
        isVerified: false,
        metadata: {},
        lastUpdated: Date.now(),
      };

      (service as any).setCachedTokenInfo(mockTokenAddress, tokenInfo);

      // Wait and clear expired entries
      setTimeout(() => {
        service.clearExpiredCache();
        const cached = (service as any).getCachedTokenInfo(mockTokenAddress);
        expect(cached).toBeNull();
      }, 100);
    });
  });
});