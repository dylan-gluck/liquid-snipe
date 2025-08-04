import { Token } from '../../types';

/**
 * Token model class providing utilities for working with token data
 */
export class TokenModel implements Token {
  public address: string;
  public symbol?: string;
  public name?: string;
  public decimals?: number;
  public firstSeen: number;
  public isVerified: boolean;
  public metadata: Record<string, any>;

  constructor(data: Token) {
    this.address = data.address;
    this.symbol = data.symbol;
    this.name = data.name;
    this.decimals = data.decimals;
    this.firstSeen = data.firstSeen || Date.now();
    this.isVerified = data.isVerified || false;
    this.metadata = data.metadata || {};
  }

  /**
   * Create a new token with minimal information
   */
  public static create(address: string, options: Partial<Token> = {}): TokenModel {
    return new TokenModel({
      address,
      firstSeen: options.firstSeen || Date.now(),
      isVerified: options.isVerified || false,
      symbol: options.symbol,
      name: options.name,
      decimals: options.decimals,
      metadata: options.metadata || {},
    });
  }

  /**
   * Format token for display, handling missing metadata
   */
  public getDisplayName(): string {
    if (this.symbol) {
      return this.name ? `${this.symbol} (${this.name})` : this.symbol;
    }
    return this.name || this.address.slice(0, 8) + '...';
  }

  /**
   * Check if the token has complete metadata
   */
  public isComplete(): boolean {
    return !!(this.symbol && this.name && this.decimals !== undefined);
  }

  /**
   * Create a string representation of the token
   */
  public toString(): string {
    const parts = [this.address];

    if (this.symbol) parts.push(this.symbol);
    if (this.name) parts.push(this.name);

    return parts.join(' - ');
  }

  /**
   * Apply an update to the token fields that exist in the update object
   */
  public update(updates: Partial<Token>): TokenModel {
    if (updates.symbol !== undefined) this.symbol = updates.symbol;
    if (updates.name !== undefined) this.name = updates.name;
    if (updates.decimals !== undefined) this.decimals = updates.decimals;
    if (updates.isVerified !== undefined) this.isVerified = updates.isVerified;

    if (updates.metadata) {
      this.metadata = { ...this.metadata, ...updates.metadata };
    }

    return this;
  }
}

export default TokenModel;
