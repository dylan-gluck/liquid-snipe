import { v4 as uuidv4 } from 'uuid';
import { Trade } from '../../types';

/**
 * Trade model class providing utilities for working with trade data
 */
export class TradeModel implements Trade {
  public id: string;
  public poolAddress: string;
  public tokenAddress: string;
  public direction: 'BUY' | 'SELL';
  public amount: number;
  public price: number;
  public valueUsd: number;
  public gasFeeUsd: number;
  public timestamp: number;
  public txSignature: string;
  public status: 'PENDING' | 'CONFIRMED' | 'FAILED';

  constructor(data: Trade) {
    this.id = data.id || uuidv4();
    this.poolAddress = data.poolAddress;
    this.tokenAddress = data.tokenAddress;
    this.direction = data.direction;
    this.amount = data.amount;
    this.price = data.price;
    this.valueUsd = data.valueUsd;
    this.gasFeeUsd = data.gasFeeUsd || 0;
    this.timestamp = data.timestamp || Date.now();
    this.txSignature = data.txSignature;
    this.status = data.status || 'PENDING';
  }

  /**
   * Create a new buy trade
   */
  public static createBuy(
    tokenAddress: string,
    poolAddress: string,
    amount: number,
    price: number,
    txSignature: string,
    options: Partial<Trade> = {}
  ): TradeModel {
    return new TradeModel({
      id: options.id || uuidv4(),
      poolAddress,
      tokenAddress,
      direction: 'BUY',
      amount,
      price,
      valueUsd: amount * price,
      gasFeeUsd: options.gasFeeUsd || 0,
      timestamp: options.timestamp || Date.now(),
      txSignature,
      status: options.status || 'PENDING',
    });
  }

  /**
   * Create a new sell trade
   */
  public static createSell(
    tokenAddress: string,
    poolAddress: string,
    amount: number,
    price: number,
    txSignature: string,
    options: Partial<Trade> = {}
  ): TradeModel {
    return new TradeModel({
      id: options.id || uuidv4(),
      poolAddress,
      tokenAddress,
      direction: 'SELL',
      amount,
      price,
      valueUsd: amount * price,
      gasFeeUsd: options.gasFeeUsd || 0,
      timestamp: options.timestamp || Date.now(),
      txSignature,
      status: options.status || 'PENDING',
    });
  }

  /**
   * Update trade status
   */
  public updateStatus(status: 'PENDING' | 'CONFIRMED' | 'FAILED'): TradeModel {
    this.status = status;
    return this;
  }

  /**
   * Update gas fee
   */
  public updateGasFee(gasFeeUsd: number): TradeModel {
    this.gasFeeUsd = gasFeeUsd;
    return this;
  }

  /**
   * Get net value (after gas fees)
   */
  public getNetValueUsd(): number {
    return this.valueUsd - this.gasFeeUsd;
  }

  /**
   * Check if the trade is completed (either confirmed or failed)
   */
  public isCompleted(): boolean {
    return this.status === 'CONFIRMED' || this.status === 'FAILED';
  }

  /**
   * Check if the trade is successful
   */
  public isSuccessful(): boolean {
    return this.status === 'CONFIRMED';
  }

  /**
   * Calculate time since the trade (in minutes)
   */
  public getAge(): number {
    return (Date.now() - this.timestamp) / (60 * 1000);
  }
}

export default TradeModel;