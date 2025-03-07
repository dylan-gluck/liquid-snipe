import { LiquidityPool } from '../../types';

/**
 * LiquidityPool model class providing utilities for working with liquidity pool data
 */
export class LiquidityPoolModel implements LiquidityPool {
  public address: string;
  public dexName: string;
  public tokenA: string;
  public tokenB: string;
  public createdAt: number;
  public initialLiquidityUsd: number;
  public lastUpdated: number;
  public currentLiquidityUsd: number;

  constructor(data: LiquidityPool) {
    this.address = data.address;
    this.dexName = data.dexName;
    this.tokenA = data.tokenA;
    this.tokenB = data.tokenB;
    this.createdAt = data.createdAt;
    this.initialLiquidityUsd = data.initialLiquidityUsd;
    this.lastUpdated = data.lastUpdated || Date.now();
    this.currentLiquidityUsd = data.currentLiquidityUsd;
  }

  /**
   * Create a new liquidity pool with required information
   */
  public static create(
    address: string,
    dexName: string,
    tokenA: string,
    tokenB: string,
    initialLiquidityUsd: number,
    options: Partial<LiquidityPool> = {}
  ): LiquidityPoolModel {
    const now = Date.now();
    
    return new LiquidityPoolModel({
      address,
      dexName,
      tokenA,
      tokenB,
      createdAt: options.createdAt || now,
      initialLiquidityUsd,
      lastUpdated: options.lastUpdated || now,
      currentLiquidityUsd: options.currentLiquidityUsd || initialLiquidityUsd,
    });
  }

  /**
   * Check if the pool contains a specific token
   */
  public containsToken(tokenAddress: string): boolean {
    return this.tokenA === tokenAddress || this.tokenB === tokenAddress;
  }

  /**
   * Get the other token in the pair (if a token address is provided)
   */
  public getCounterpartyToken(tokenAddress: string): string | null {
    if (this.tokenA === tokenAddress) return this.tokenB;
    if (this.tokenB === tokenAddress) return this.tokenA;
    return null;
  }

  /**
   * Calculate liquidity change since pool creation
   */
  public getLiquidityChangePercentage(): number {
    if (this.initialLiquidityUsd === 0) return 0;
    return ((this.currentLiquidityUsd - this.initialLiquidityUsd) / this.initialLiquidityUsd) * 100;
  }

  /**
   * Check if the pool is new (less than N hours old)
   */
  public isNew(hoursThreshold = 24): boolean {
    const ageInMs = Date.now() - this.createdAt;
    const hoursInMs = hoursThreshold * 60 * 60 * 1000;
    return ageInMs < hoursInMs;
  }

  /**
   * Update the pool's liquidity information
   */
  public updateLiquidity(currentLiquidityUsd: number): LiquidityPoolModel {
    this.currentLiquidityUsd = currentLiquidityUsd;
    this.lastUpdated = Date.now();
    return this;
  }

  /**
   * Calculate time since the pool was created (in hours)
   */
  public getAge(): number {
    return (Date.now() - this.createdAt) / (60 * 60 * 1000);
  }
}

export default LiquidityPoolModel;