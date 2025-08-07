/**
 * Base classes and interfaces for exit strategies
 * Separated to avoid circular dependencies
 */

import { PositionModel } from '../db/models/position';
import { ExitStrategyConfig } from '../types';

/**
 * Interface for current token price data
 */
export interface TokenPrice {
  tokenAddress: string;
  price: number;
  timestamp: number;
  source: string;
}

/**
 * Exit strategy evaluation result
 */
export interface ExitEvaluationResult {
  shouldExit: boolean;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  expectedPrice?: number;
  partialExitPercentage?: number;
}

/**
 * Exit strategy interface
 */
export interface ExitStrategy {
  type: ExitStrategyConfig['type'];
  evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult;
  getDescription(): string;
}

/**
 * Base abstract class for exit strategies
 */
export abstract class BaseExitStrategy implements ExitStrategy {
  constructor(protected config: ExitStrategyConfig) {}

  abstract get type(): ExitStrategyConfig['type'];
  abstract evaluate(position: PositionModel, currentPrice: TokenPrice): ExitEvaluationResult;
  abstract getDescription(): string;
}