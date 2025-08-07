import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
// Import Metadata type properly
// import { Metadata } from '@metaplex-foundation/mpl-token-metadata';
import { ConnectionManager } from './connection-manager';
import { DatabaseManager } from '../db';
import { Token } from '../types';
import { Logger } from '../utils/logger';
import { PriceFeedService, PriceData } from '../data/price-feed-service';

/**
 * Represents token holder information
 */
export interface TokenHolder {
  address: string;
  balance: number;
  percentage: number;
}

/**
 * Represents comprehensive token information
 */
export interface TokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  supply?: number;
  holders?: TokenHolder[];
  holderCount?: number;
  topHolderPercentage?: number;
  riskScore: number;
  age?: number;
  isVerified: boolean;
  metadata: Record<string, any>;
  lastUpdated: number;
}

/**
 * Risk assessment parameters for token evaluation
 */
export interface RiskAssessment {
  score: number; // 0-10 scale (0 = lowest risk, 10 = highest risk)
  factors: {
    supply: number;
    holderDistribution: number;
    age: number;
    metadata: number;
    verification: number;
  };
  warnings: string[];
}

/**
 * Cache entry for token information
 */
interface CacheEntry {
  data: TokenInfo;
  expiry: number;
}

/**
 * Service for fetching and analyzing token information from the blockchain
 */
export class TokenInfoService {
  private connectionManager: ConnectionManager;
  private dbManager: DatabaseManager;
  private logger: Logger;
  private priceFeedService?: PriceFeedService;
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheExpiryMs: number;

  constructor(
    connectionManager: ConnectionManager,
    dbManager: DatabaseManager,
    options: {
      cacheExpiryMinutes?: number;
      priceFeedService?: PriceFeedService;
    } = {},
  ) {
    this.connectionManager = connectionManager;
    this.dbManager = dbManager;
    this.logger = new Logger('TokenInfoService');
    this.priceFeedService = options.priceFeedService;
    this.cacheExpiryMs = (options.cacheExpiryMinutes ?? 30) * 60 * 1000; // Default 30 minutes
  }

  /**
   * Get comprehensive token information
   */
  public async getTokenInfo(address: string): Promise<TokenInfo | null> {
    try {
      // Check cache first
      const cached = this.getCachedTokenInfo(address);
      if (cached) {
        this.logger.debug(`Retrieved cached token info for ${address}`);
        return cached;
      }

      this.logger.debug(`Fetching token info for ${address}`);

      // Check database first
      const dbToken = await this.dbManager.getToken(address);

      let tokenInfo: TokenInfo;

      if (dbToken && this.isTokenInfoFresh(dbToken)) {
        // Convert database token to TokenInfo
        tokenInfo = this.convertDbTokenToTokenInfo(dbToken);
      } else {
        // Fetch fresh data from blockchain
        const freshTokenInfo = await this.fetchTokenInfoFromBlockchain(address);

        if (freshTokenInfo) {
          tokenInfo = freshTokenInfo;
          // Save to database
          await this.saveTokenToDatabase(tokenInfo);
        } else {
          return null;
        }
      }

      if (tokenInfo) {
        // Enhance with price data if price feed service is available
        if (this.priceFeedService) {
          try {
            const priceData = await this.priceFeedService.getTokenPrice(address, tokenInfo.symbol);
            if (priceData) {
              tokenInfo.metadata = {
                ...tokenInfo.metadata,
                currentPrice: priceData.price,
                volume24h: priceData.volume24h,
                marketCap: priceData.marketCap,
                priceChange24h: priceData.priceChange24h,
                priceSource: priceData.source,
                priceTimestamp: priceData.timestamp,
              };
            }
          } catch (error) {
            this.logger.debug(`Failed to get price data for ${address}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        
        // Cache the result
        this.setCachedTokenInfo(address, tokenInfo);
        return tokenInfo;
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to get token info for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetch token metadata from on-chain sources
   */
  public async fetchOnChainMetadata(address: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
    metadata?: Record<string, any>;
  }> {
    try {
      const connection = this.connectionManager.getConnection();
      const mint = new PublicKey(address);

      // Get mint account info
      const mintInfo = await connection.getParsedAccountInfo(mint);

      if (!mintInfo.value?.data || typeof mintInfo.value.data === 'string') {
        this.logger.warning(`No mint data found for token ${address}`);
        return {};
      }

      const parsedData = mintInfo.value.data as any;
      const mintData = parsedData.parsed?.info;

      if (!mintData) {
        this.logger.warning(`Could not parse mint data for token ${address}`);
        return {};
      }

      const result: any = {
        decimals: mintData.decimals,
        metadata: {
          supply: mintData.supply,
          mintAuthority: mintData.mintAuthority,
          freezeAuthority: mintData.freezeAuthority,
        },
      };

      // Try to fetch Metaplex metadata
      try {
        const metadataPDA = this.getMetadataPDA(mint);
        const metadataAccount = await connection.getAccountInfo(metadataPDA);

        if (metadataAccount) {
          // For now, we'll skip Metaplex metadata parsing due to import complexity
          // This can be enhanced later with proper Metaplex integration
          this.logger.debug(`Found Metaplex metadata account for ${address}`);
        }
      } catch (metadataError) {
        this.logger.debug(`Could not fetch Metaplex metadata for ${address}`, {
          error: metadataError instanceof Error ? metadataError.message : String(metadataError),
        });
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to fetch on-chain metadata for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * Get token supply information
   */
  public async getSupplyInfo(address: string): Promise<{
    totalSupply: number;
    circulatingSupply: number;
  } | null> {
    try {
      const connection = this.connectionManager.getConnection();
      const mint = new PublicKey(address);

      const supply = await connection.getTokenSupply(mint);

      if (!supply.value) {
        return null;
      }

      // For now, assume total supply equals circulating supply
      // This could be enhanced to account for locked/burned tokens
      const totalSupply = parseInt(supply.value.amount);

      return {
        totalSupply,
        circulatingSupply: totalSupply,
      };
    } catch (error) {
      this.logger.error(`Failed to get supply info for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Analyze token holder distribution
   */
  public async analyzeHolders(
    address: string,
    maxHolders: number = 100,
  ): Promise<{
    holders: TokenHolder[];
    holderCount: number;
    topHolderPercentage: number;
  } | null> {
    try {
      const connection = this.connectionManager.getConnection();
      const mint = new PublicKey(address);

      // Get all token accounts for this mint
      const tokenAccounts = await connection.getProgramAccounts(
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token Program
        {
          filters: [
            {
              dataSize: 165, // Token account data size
            },
            {
              memcmp: {
                offset: 0,
                bytes: mint.toBase58(),
              },
            },
          ],
        },
      );

      if (tokenAccounts.length === 0) {
        return null;
      }

      // Parse token account data to get balances
      const holders: TokenHolder[] = [];
      let totalSupply = 0;

      for (const account of tokenAccounts.slice(0, maxHolders)) {
        try {
          const accountInfo = await connection.getParsedAccountInfo(account.pubkey);

          if (accountInfo.value?.data && typeof accountInfo.value.data !== 'string') {
            const parsedData = accountInfo.value.data as any;
            const tokenData = parsedData.parsed?.info;

            if (tokenData && tokenData.tokenAmount) {
              const balance = parseInt(tokenData.tokenAmount.amount);
              totalSupply += balance;

              if (balance > 0) {
                holders.push({
                  address: account.pubkey.toBase58(),
                  balance,
                  percentage: 0, // Will be calculated after we have total supply
                });
              }
            }
          }
        } catch (error) {
          // Skip accounts that can't be parsed
          continue;
        }
      }

      // Calculate percentages
      holders.forEach(holder => {
        holder.percentage = totalSupply > 0 ? (holder.balance / totalSupply) * 100 : 0;
      });

      // Sort by balance descending
      holders.sort((a, b) => b.balance - a.balance);

      const topHolderPercentage = holders.length > 0 ? holders[0].percentage : 0;

      return {
        holders,
        holderCount: tokenAccounts.length,
        topHolderPercentage,
      };
    } catch (error) {
      this.logger.error(`Failed to analyze holders for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Calculate risk score for a token
   */
  public calculateRiskScore(tokenInfo: Partial<TokenInfo>): RiskAssessment {
    const factors = {
      supply: 0,
      holderDistribution: 0,
      age: 0,
      metadata: 0,
      verification: 0,
    };

    const warnings: string[] = [];

    // Supply risk (0-2 points)
    if (tokenInfo.supply !== undefined) {
      if (tokenInfo.supply > 1e12) {
        factors.supply = 2;
        warnings.push('Extremely high token supply');
      } else if (tokenInfo.supply > 1e9) {
        factors.supply = 1;
        warnings.push('High token supply');
      } else {
        factors.supply = 0;
      }
    } else {
      factors.supply = 1;
      warnings.push('Supply information unavailable');
    }

    // Holder distribution risk (0-3 points)
    if (tokenInfo.topHolderPercentage !== undefined) {
      if (tokenInfo.topHolderPercentage > 50) {
        factors.holderDistribution = 3;
        warnings.push('High concentration - top holder owns >50%');
      } else if (tokenInfo.topHolderPercentage > 20) {
        factors.holderDistribution = 2;
        warnings.push('Medium concentration - top holder owns >20%');
      } else if (tokenInfo.topHolderPercentage > 10) {
        factors.holderDistribution = 1;
        warnings.push('Some concentration - top holder owns >10%');
      } else {
        factors.holderDistribution = 0;
      }
    } else {
      factors.holderDistribution = 2;
      warnings.push('Holder distribution unknown');
    }

    // Age risk (0-2 points)
    if (tokenInfo.age !== undefined) {
      const ageHours = tokenInfo.age / (1000 * 60 * 60);
      if (ageHours < 1) {
        factors.age = 2;
        warnings.push('Very new token (<1 hour old)');
      } else if (ageHours < 24) {
        factors.age = 1;
        warnings.push('New token (<24 hours old)');
      } else {
        factors.age = 0;
      }
    } else {
      factors.age = 1;
      warnings.push('Token age unknown');
    }

    // Metadata risk (0-2 points)
    if (!tokenInfo.symbol || !tokenInfo.name) {
      factors.metadata = 2;
      warnings.push('Missing token metadata');
    } else if (tokenInfo.symbol.length < 2 || tokenInfo.name.length < 3) {
      factors.metadata = 1;
      warnings.push('Incomplete token metadata');
    } else {
      factors.metadata = 0;
    }

    // Verification risk (0-1 points)
    if (!tokenInfo.isVerified) {
      factors.verification = 1;
      warnings.push('Token not verified');
    } else {
      factors.verification = 0;
    }

    const totalScore = Object.values(factors).reduce((sum, score) => sum + score, 0);

    return {
      score: Math.min(totalScore, 10), // Cap at 10
      factors,
      warnings,
    };
  }

  /**
   * Identify if a token is likely new based on common patterns
   */
  public isNewToken(tokenAInfo: TokenInfo, tokenBInfo: TokenInfo): TokenInfo | null {
    const stableTokens = ['USDC', 'USDT', 'SOL', 'WSOL'];

    // Check if tokenA is a stablecoin/SOL and tokenB is not
    if (
      tokenAInfo.symbol &&
      stableTokens.includes(tokenAInfo.symbol) &&
      tokenBInfo.symbol &&
      !stableTokens.includes(tokenBInfo.symbol)
    ) {
      return tokenBInfo;
    }

    // Check if tokenB is a stablecoin/SOL and tokenA is not
    if (
      tokenBInfo.symbol &&
      stableTokens.includes(tokenBInfo.symbol) &&
      tokenAInfo.symbol &&
      !stableTokens.includes(tokenAInfo.symbol)
    ) {
      return tokenAInfo;
    }

    // If both or neither are stablecoins, use age as a factor
    if (tokenAInfo.age !== undefined && tokenBInfo.age !== undefined) {
      return tokenAInfo.age < tokenBInfo.age ? tokenAInfo : tokenBInfo;
    }

    // Fallback: return the one with higher risk score (likely newer/less established)
    return tokenAInfo.riskScore > tokenBInfo.riskScore ? tokenAInfo : tokenBInfo;
  }

  /**
   * Clear expired cache entries
   */
  public clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry < now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cached token information if available and not expired
   */
  private getCachedTokenInfo(address: string): TokenInfo | null {
    const entry = this.cache.get(address);
    if (entry && entry.expiry > Date.now()) {
      return entry.data;
    }

    if (entry) {
      this.cache.delete(address); // Remove expired entry
    }

    return null;
  }

  /**
   * Cache token information
   */
  private setCachedTokenInfo(address: string, tokenInfo: TokenInfo): void {
    this.cache.set(address, {
      data: tokenInfo,
      expiry: Date.now() + this.cacheExpiryMs,
    });
  }

  /**
   * Check if database token info is still fresh
   */
  private isTokenInfoFresh(token: Token): boolean {
    const ageMs = Date.now() - token.firstSeen;
    const freshThresholdMs = 30 * 60 * 1000; // 30 minutes
    return ageMs < freshThresholdMs;
  }

  /**
   * Convert database Token to TokenInfo
   */
  private convertDbTokenToTokenInfo(dbToken: Token): TokenInfo {
    return {
      address: dbToken.address,
      symbol: dbToken.symbol,
      name: dbToken.name,
      decimals: dbToken.decimals,
      riskScore: this.calculateRiskScore(dbToken).score,
      age: Date.now() - dbToken.firstSeen,
      isVerified: dbToken.isVerified,
      metadata: dbToken.metadata,
      lastUpdated: dbToken.firstSeen,
    };
  }

  /**
   * Fetch comprehensive token information from blockchain
   */
  private async fetchTokenInfoFromBlockchain(address: string): Promise<TokenInfo | null> {
    try {
      // Fetch metadata
      const metadata = await this.fetchOnChainMetadata(address);

      // If we can't get basic metadata, consider this a failure
      if (!metadata || Object.keys(metadata).length === 0) {
        this.logger.warning(`No basic metadata available for token ${address}`);
        return null;
      }

      // Fetch supply info
      const supplyInfo = await this.getSupplyInfo(address);

      // Fetch holder analysis (limited for performance)
      const holderInfo = await this.analyzeHolders(address, 50);

      const tokenInfo: TokenInfo = {
        address,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        supply: supplyInfo?.totalSupply,
        holders: holderInfo?.holders,
        holderCount: holderInfo?.holderCount,
        topHolderPercentage: holderInfo?.topHolderPercentage,
        riskScore: 0,
        age: 0, // Will be set based on first seen
        isVerified: false, // Could be enhanced with verification logic
        metadata: metadata.metadata || {},
        lastUpdated: Date.now(),
      };

      // Calculate risk score
      const riskAssessment = this.calculateRiskScore(tokenInfo);
      tokenInfo.riskScore = riskAssessment.score;

      return tokenInfo;
    } catch (error) {
      this.logger.error(`Failed to fetch token info from blockchain for ${address}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Save token information to database
   */
  private async saveTokenToDatabase(tokenInfo: TokenInfo): Promise<void> {
    try {
      const dbToken: Token = {
        address: tokenInfo.address,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
        firstSeen: Date.now(),
        isVerified: tokenInfo.isVerified,
        metadata: {
          ...tokenInfo.metadata,
          supply: tokenInfo.supply,
          holderCount: tokenInfo.holderCount,
          topHolderPercentage: tokenInfo.topHolderPercentage,
          riskScore: tokenInfo.riskScore,
        },
      };

      await this.dbManager.addToken(dbToken);
      this.logger.debug(`Saved token ${tokenInfo.address} to database`);
    } catch (error) {
      this.logger.error(`Failed to save token ${tokenInfo.address} to database`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the metadata PDA (Program Derived Address) for a token
   */
  private getMetadataPDA(mint: PublicKey): PublicKey {
    const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID,
    );

    return metadataPDA;
  }
}
