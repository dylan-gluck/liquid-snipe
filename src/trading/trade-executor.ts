import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  TransactionConfirmationStatus,
} from '@solana/web3.js';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { ConnectionManager } from '../blockchain/connection-manager';
import { DatabaseManager } from '../db';
import { Logger } from '../utils/logger';
import {
  TradeDecision,
  TradeResult,
  Trade,
  Position,
  TradeConfig,
  WalletConfig,
  AppConfig,
} from '../types';

/**
 * Represents a swap transaction result
 */
interface SwapTransactionResult {
  transaction: Transaction;
  expectedAmountOut: number;
  priceImpact: number;
  minimumAmountOut: number;
}

/**
 * Represents wallet balance information
 */
interface WalletBalance {
  sol: number;
  tokens: Map<string, number>;
  totalValueUsd: number;
}

/**
 * Represents transaction confirmation details
 */
interface TransactionConfirmation {
  signature: string;
  confirmed: boolean;
  error?: string;
  gasFeeUsed: number;
  actualAmountOut?: number;
}

/**
 * Represents a circuit breaker state
 */
interface CircuitBreakerState {
  isTripped: boolean;
  trippedAt?: number;
  reason?: string;
  resetAfter: number; // milliseconds
}

/**
 * Main trade executor that handles transaction creation, signing, and submission
 */
export class TradeExecutor {
  private connectionManager: ConnectionManager;
  private dbManager: DatabaseManager;
  private config: AppConfig;
  private logger: Logger;
  private wallet?: Keypair;
  private circuitBreakers: Map<string, CircuitBreakerState>;
  private transactionRetryCount: Map<string, number>;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  constructor(connectionManager: ConnectionManager, dbManager: DatabaseManager, config: AppConfig) {
    this.connectionManager = connectionManager;
    this.dbManager = dbManager;
    this.config = config;
    this.logger = new Logger('TradeExecutor');
    this.circuitBreakers = new Map();
    this.transactionRetryCount = new Map();

    // Initialize circuit breakers
    this.initializeCircuitBreakers();
  }

  /**
   * Initialize the wallet from keypair file
   */
  public async initialize(): Promise<void> {
    try {
      if (!this.config.wallet.keypairPath) {
        throw new Error('Wallet keypair path not configured');
      }

      // Load wallet keypair securely
      const keypairData = JSON.parse(readFileSync(this.config.wallet.keypairPath, 'utf-8'));
      this.wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

      this.logger.info(`Wallet initialized: ${this.wallet.publicKey.toBase58()}`);

      // Verify wallet has sufficient balance
      await this.verifyWalletBalance();
    } catch (error) {
      this.logger.error('Failed to initialize wallet:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute a trade based on a decision from the strategy engine
   */
  public async executeTrade(decision: TradeDecision): Promise<TradeResult> {
    const startTime = Date.now();
    const tradeId = randomUUID();

    try {
      this.logger.info(`Executing trade: ${tradeId}`, {
        targetToken: decision.targetToken,
        baseToken: decision.baseToken,
        amountUsd: decision.tradeAmountUsd,
      });

      // Check if wallet is initialized
      if (!this.wallet) {
        throw new Error('Wallet not initialized');
      }

      // Check circuit breakers
      if (this.isCircuitBreakerTripped('trading')) {
        throw new Error('Trading circuit breaker is active');
      }

      // Verify wallet balance before trade
      const walletBalance = await this.getWalletBalance();
      if (walletBalance.sol < 0.01) {
        // Minimum SOL for gas
        throw new Error('Insufficient SOL balance for transaction fees');
      }

      // Check trade limits
      await this.validateTradeDecision(decision);

      // Prepare swap transaction
      const swapResult = await this.prepareSwapTransaction(decision);

      // Execute transaction with retries
      const confirmation = await this.executeTransactionWithRetries(
        swapResult.transaction,
        tradeId,
      );

      if (!confirmation.confirmed) {
        throw new Error(`Transaction failed: ${confirmation.error}`);
      }

      // Record successful trade
      const trade: Trade = {
        id: tradeId,
        poolAddress: decision.poolAddress,
        tokenAddress: decision.targetToken,
        direction: 'BUY',
        amount: confirmation.actualAmountOut || swapResult.expectedAmountOut,
        price: decision.price || 0,
        valueUsd: decision.tradeAmountUsd,
        gasFeeUsd: this.solToUsd(confirmation.gasFeeUsed),
        timestamp: Date.now(),
        txSignature: confirmation.signature,
        status: 'CONFIRMED',
      };

      await this.dbManager.addTrade(trade);

      // Create new position
      const position = await this.createPosition(trade, decision);

      const executionTime = Date.now() - startTime;
      this.logger.info(`Trade executed successfully in ${executionTime}ms`, {
        tradeId,
        signature: confirmation.signature,
        positionId: position.id,
      });

      return {
        success: true,
        signature: confirmation.signature,
        tradeId,
        positionId: position.id,
        actualAmountOut: confirmation.actualAmountOut || swapResult.expectedAmountOut,
        timestamp: Date.now(),
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logger.error(`Trade execution failed after ${executionTime}ms:`, {
        tradeId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Record failed trade attempt
      await this.recordFailedTrade(tradeId, decision, error);

      // Update circuit breaker if needed
      await this.updateCircuitBreaker('trading', false);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Prepare a swap transaction
   */
  private async prepareSwapTransaction(decision: TradeDecision): Promise<SwapTransactionResult> {
    try {
      // This is a simplified implementation
      // In practice, this would integrate with DEX-specific swap programs
      // like Jupiter, Raydium, or Orca

      const connection = this.connectionManager.getConnection();
      const transaction = new Transaction();

      // Mock implementation - would need actual DEX integration
      const expectedAmountOut =
        decision.expectedAmountOut || decision.tradeAmountUsd / (decision.price || 0.001);

      const priceImpact = this.calculatePriceImpact(decision.tradeAmountUsd, decision.poolAddress);
      const slippageTolerance = this.config.tradeConfig.maxSlippagePercent / 100;
      const minimumAmountOut = expectedAmountOut * (1 - slippageTolerance);

      // Add mock instruction (would be actual swap instruction)
      // transaction.add(createSwapInstruction(...));

      // Set transaction properties
      const latestBlockhash = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = this.wallet!.publicKey;

      return {
        transaction,
        expectedAmountOut,
        priceImpact,
        minimumAmountOut,
      };
    } catch (error) {
      this.logger.error('Failed to prepare swap transaction:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute transaction with retry logic
   */
  private async executeTransactionWithRetries(
    transaction: Transaction,
    tradeId: string,
  ): Promise<TransactionConfirmation> {
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < this.MAX_RETRIES) {
      try {
        // Sign transaction
        transaction.sign(this.wallet!);

        // Submit transaction
        const connection = this.connectionManager.getConnection();
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'processed',
        });

        this.logger.debug(`Transaction submitted: ${signature}`, {
          tradeId,
          attempt: retryCount + 1,
        });

        // Wait for confirmation
        const confirmation = await this.waitForConfirmation(signature);

        if (confirmation.confirmed) {
          return confirmation;
        } else {
          throw new Error(confirmation.error || 'Transaction not confirmed');
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;

        this.logger.warning(`Transaction attempt ${retryCount} failed:`, {
          tradeId,
          error: lastError.message,
        });

        if (retryCount < this.MAX_RETRIES) {
          // Wait before retry with exponential backoff
          const delayMs = this.RETRY_DELAY_MS * Math.pow(2, retryCount - 1);
          await new Promise(resolve => setTimeout(resolve, delayMs));

          // Get fresh blockhash for retry
          const connection = this.connectionManager.getConnection();
          const latestBlockhash = await connection.getLatestBlockhash();
          transaction.recentBlockhash = latestBlockhash.blockhash;
        }
      }
    }

    return {
      signature: '',
      confirmed: false,
      error: lastError?.message || 'Transaction failed after all retries',
      gasFeeUsed: 0,
    };
  }

  /**
   * Wait for transaction confirmation
   */
  private async waitForConfirmation(signature: string): Promise<TransactionConfirmation> {
    try {
      const connection = this.connectionManager.getConnection();

      // Wait for confirmation with timeout
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        return {
          signature,
          confirmed: false,
          error: `Transaction error: ${JSON.stringify(confirmation.value.err)}`,
          gasFeeUsed: 0,
        };
      }

      // Get transaction details to extract gas fee and amounts
      const txDetails = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      const gasFeeUsed = txDetails?.meta?.fee || 0;

      // TODO: Parse transaction logs to extract actual amount out
      // This would depend on the specific DEX program being used

      return {
        signature,
        confirmed: true,
        gasFeeUsed: gasFeeUsed / 1e9, // Convert lamports to SOL
      };
    } catch (error) {
      return {
        signature,
        confirmed: false,
        error: error instanceof Error ? error.message : String(error),
        gasFeeUsed: 0,
      };
    }
  }

  /**
   * Create a new position record
   */
  private async createPosition(trade: Trade, decision: TradeDecision): Promise<Position> {
    const positionId = randomUUID();
    const position: Position = {
      id: positionId,
      tokenAddress: decision.targetToken,
      entryPrice: decision.price || 0,
      amount: trade.amount,
      openTimestamp: Date.now(),
      entryTradeId: trade.id,
      exitStrategy: this.config.exitStrategies[0], // Use first configured strategy
      status: 'OPEN',
    };

    await this.dbManager.addPosition(position);
    return position;
  }

  /**
   * Get current wallet balance
   */
  public async getWalletBalance(): Promise<WalletBalance> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.connectionManager.getConnection();
      const solBalance = await connection.getBalance(this.wallet.publicKey);

      // TODO: Implement token balance fetching
      // This would require parsing all token accounts for the wallet

      return {
        sol: solBalance / 1e9, // Convert lamports to SOL
        tokens: new Map(),
        totalValueUsd: (solBalance / 1e9) * 100, // Mock SOL price of $100
      };
    } catch (error) {
      this.logger.error('Failed to get wallet balance:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate trade decision against limits and constraints
   */
  private async validateTradeDecision(decision: TradeDecision): Promise<void> {
    // Check maximum trade amount
    if (decision.tradeAmountUsd > (this.config.tradeConfig.maxTradeAmountUsd || 1000)) {
      throw new Error(
        `Trade amount exceeds maximum: ${decision.tradeAmountUsd} > ${this.config.tradeConfig.maxTradeAmountUsd}`,
      );
    }

    // Check minimum trade amount
    if (decision.tradeAmountUsd < 1) {
      throw new Error(`Trade amount below minimum: ${decision.tradeAmountUsd}`);
    }

    // Check risk limits
    const walletBalance = await this.getWalletBalance();
    const riskAmount = walletBalance.totalValueUsd * (this.config.wallet.riskPercent / 100);

    if (decision.tradeAmountUsd > riskAmount) {
      throw new Error(`Trade exceeds risk limit: ${decision.tradeAmountUsd} > ${riskAmount}`);
    }

    // Additional validation could include:
    // - Token blacklist checking
    // - Pool liquidity verification
    // - Slippage estimation
  }

  /**
   * Verify wallet has sufficient balance for trading
   */
  private async verifyWalletBalance(): Promise<void> {
    const balance = await this.getWalletBalance();

    if (balance.sol < 0.01) {
      this.logger.warning('Low SOL balance for transaction fees', { balance: balance.sol });
    }

    this.logger.info('Wallet balance verified', {
      sol: balance.sol,
      totalValueUsd: balance.totalValueUsd,
    });
  }

  /**
   * Calculate price impact for a trade
   */
  private calculatePriceImpact(tradeAmountUsd: number, poolAddress: string): number {
    // Mock implementation - would need actual pool liquidity data
    // Price impact typically increases with trade size relative to pool liquidity
    const mockPoolSize = 50000; // $50k pool
    const impact = Math.min(0.1, (tradeAmountUsd / mockPoolSize) * 0.05); // Max 10% impact
    return impact;
  }

  /**
   * Convert SOL amount to USD (mock implementation)
   */
  private solToUsd(solAmount: number): number {
    return solAmount * 100; // Mock SOL price of $100
  }

  /**
   * Initialize circuit breakers
   */
  private initializeCircuitBreakers(): void {
    this.circuitBreakers.set('trading', {
      isTripped: false,
      resetAfter: 5 * 60 * 1000, // 5 minutes
    });

    this.circuitBreakers.set('balance', {
      isTripped: false,
      resetAfter: 1 * 60 * 1000, // 1 minute
    });
  }

  /**
   * Check if a circuit breaker is tripped
   */
  private isCircuitBreakerTripped(name: string): boolean {
    const breaker = this.circuitBreakers.get(name);
    if (!breaker || !breaker.isTripped) {
      return false;
    }

    // Check if it should be reset
    if (breaker.trippedAt && Date.now() - breaker.trippedAt > breaker.resetAfter) {
      breaker.isTripped = false;
      breaker.trippedAt = undefined;
      breaker.reason = undefined;
      this.logger.info(`Circuit breaker reset: ${name}`);
      return false;
    }

    return true;
  }

  /**
   * Update circuit breaker state
   */
  private async updateCircuitBreaker(name: string, success: boolean): Promise<void> {
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return;

    if (!success) {
      // Check if we should trip the breaker based on recent failures
      // This is a simplified implementation
      const recentFailures = await this.getRecentFailureCount(name);

      if (recentFailures >= 3) {
        breaker.isTripped = true;
        breaker.trippedAt = Date.now();
        breaker.reason = `Too many failures: ${recentFailures}`;

        this.logger.warning(`Circuit breaker tripped: ${name}`, {
          reason: breaker.reason,
          resetAfter: breaker.resetAfter,
        });
      }
    }
  }

  /**
   * Get recent failure count for circuit breaker evaluation
   */
  private async getRecentFailureCount(type: string): Promise<number> {
    // Mock implementation - would query database for recent failures
    return Math.floor(Math.random() * 5);
  }

  /**
   * Record a failed trade attempt
   */
  private async recordFailedTrade(
    tradeId: string,
    decision: TradeDecision,
    error: unknown,
  ): Promise<void> {
    try {
      const failedTrade: Trade = {
        id: tradeId,
        poolAddress: decision.poolAddress,
        tokenAddress: decision.targetToken,
        direction: 'BUY',
        amount: 0,
        price: decision.price || 0,
        valueUsd: decision.tradeAmountUsd,
        gasFeeUsd: 0,
        timestamp: Date.now(),
        txSignature: '',
        status: 'FAILED',
      };

      await this.dbManager.addTrade(failedTrade);
    } catch (dbError) {
      this.logger.error('Failed to record failed trade:', {
        tradeId,
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
  }

  /**
   * Get trade executor statistics
   */
  public getStats(): {
    walletAddress?: string;
    circuitBreakers: Array<{
      name: string;
      isTripped: boolean;
      reason?: string;
    }>;
  } {
    return {
      walletAddress: this.wallet?.publicKey.toBase58(),
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([name, breaker]) => ({
        name,
        isTripped: breaker.isTripped,
        reason: breaker.reason,
      })),
    };
  }
}
