import { v4 as uuidv4 } from 'uuid';
import { Position, ExitStrategyConfig } from '../../types';

/**
 * Position model class providing utilities for working with position data
 */
export class PositionModel implements Position {
  public id: string;
  public tokenAddress: string;
  public entryPrice: number;
  public amount: number;
  public openTimestamp: number;
  public closeTimestamp?: number;
  public entryTradeId: string;
  public exitTradeId?: string;
  public exitStrategy: ExitStrategyConfig;
  public status: 'OPEN' | 'CLOSED';
  public pnlUsd?: number;
  public pnlPercent?: number;

  constructor(data: Position) {
    this.id = data.id || uuidv4();
    this.tokenAddress = data.tokenAddress;
    this.entryPrice = data.entryPrice;
    this.amount = data.amount;
    this.openTimestamp = data.openTimestamp || Date.now();
    this.closeTimestamp = data.closeTimestamp;
    this.entryTradeId = data.entryTradeId;
    this.exitTradeId = data.exitTradeId;
    this.exitStrategy = data.exitStrategy;
    this.status = data.status || 'OPEN';
    this.pnlUsd = data.pnlUsd;
    this.pnlPercent = data.pnlPercent;
  }

  /**
   * Create a new open position
   */
  public static create(
    tokenAddress: string,
    entryPrice: number,
    amount: number,
    entryTradeId: string,
    exitStrategy: ExitStrategyConfig,
    options: Partial<Position> = {},
  ): PositionModel {
    return new PositionModel({
      id: options.id || uuidv4(),
      tokenAddress,
      entryPrice,
      amount,
      openTimestamp: options.openTimestamp || Date.now(),
      entryTradeId,
      exitStrategy,
      status: 'OPEN',
    });
  }

  /**
   * Close the position
   */
  public close(exitTradeId: string, exitPrice: number): PositionModel {
    this.status = 'CLOSED';
    this.exitTradeId = exitTradeId;
    this.closeTimestamp = Date.now();

    // Calculate PnL
    const entryValue = this.entryPrice * this.amount;
    const exitValue = exitPrice * this.amount;
    this.pnlUsd = exitValue - entryValue;
    this.pnlPercent = (exitValue / entryValue - 1) * 100;

    return this;
  }

  /**
   * Calculate current PnL at a given current price
   */
  public calculatePnl(currentPrice: number): { pnlUsd: number; pnlPercent: number } {
    const entryValue = this.entryPrice * this.amount;
    const currentValue = currentPrice * this.amount;
    const pnlUsd = currentValue - entryValue;
    const pnlPercent = (currentValue / entryValue - 1) * 100;

    return { pnlUsd, pnlPercent };
  }

  /**
   * Calculate position value at current price
   */
  public calculateValue(currentPrice: number): number {
    return this.amount * currentPrice;
  }

  /**
   * Check if position is hitting profit target
   */
  public isHittingProfit(currentPrice: number, targetPercentage: number): boolean {
    const { pnlPercent } = this.calculatePnl(currentPrice);
    return pnlPercent >= targetPercentage;
  }

  /**
   * Check if position is hitting stop loss
   */
  public isHittingStopLoss(currentPrice: number, stopLossPercentage: number): boolean {
    const { pnlPercent } = this.calculatePnl(currentPrice);
    return pnlPercent <= -Math.abs(stopLossPercentage);
  }

  /**
   * Calculate holding time (in minutes)
   */
  public getHoldingTimeMinutes(): number {
    const endTime = this.closeTimestamp || Date.now();
    return (endTime - this.openTimestamp) / (60 * 1000);
  }

  /**
   * Check if profit target from exit strategy is reached
   */
  public isProfitTargetReached(currentPrice: number): boolean {
    if (this.exitStrategy.type !== 'profit') return false;
    const profitParams = this.exitStrategy.params as { profitPercentage: number };
    return this.isHittingProfit(currentPrice, profitParams.profitPercentage);
  }

  /**
   * Check if time exit condition from exit strategy is reached
   */
  public isTimeExitReached(): boolean {
    if (this.exitStrategy.type !== 'time') return false;
    const timeParams = this.exitStrategy.params as { timeMinutes: number };
    return this.getHoldingTimeMinutes() >= timeParams.timeMinutes;
  }

  /**
   * Check if loss exit condition from exit strategy is reached
   */
  public isLossExitReached(currentPrice: number): boolean {
    if (this.exitStrategy.type !== 'loss') return false;
    const lossParams = this.exitStrategy.params as { lossPercentage: number };
    return this.isHittingStopLoss(currentPrice, lossParams.lossPercentage);
  }
}

export default PositionModel;
