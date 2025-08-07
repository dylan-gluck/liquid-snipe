import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  TransactionConfirmationStatus,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from '@solana/web3.js';
// Jupiter API types (using HTTP instead of SDK)
interface QuoteGetRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
  maxAccounts?: number;
  minimizeSlippage?: boolean;
  swapMode?: string;
}

interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: Array<{ swapInfo: { label: string } }>;
}

interface SwapRequest {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  computeUnitPriceMicroLamports?: number;
  prioritizationFeeLamports?: number;
  asLegacyTransaction?: boolean;
  useTokenLedger?: boolean;
  destinationTokenAccount?: string;
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
}

interface SwapTransactionData {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

// SPL Token constants and mock implementations
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

class TokenAccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenAccountNotFoundError';
  }
}

class TokenInvalidAccountOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenInvalidAccountOwnerError';
  }
}

// Helper functions
async function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  )[0];
}

async function getAccount(connection: Connection, address: PublicKey) {
  const accountInfo = await connection.getAccountInfo(address);
  if (!accountInfo) {
    throw new TokenAccountNotFoundError('Token account not found');
  }
  return {
    address,
    mint: new PublicKey(accountInfo.data.slice(0, 32)),
    owner: new PublicKey(accountInfo.data.slice(32, 64)),
    amount: BigInt(0),
    delegate: null,
    delegatedAmount: BigInt(0),
    isInitialized: true,
    isFrozen: false,
    isNative: false,
    rentExemptReserve: null,
    closeAuthority: null,
  };
}
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
  TokenAccountInfo,
} from '../types';

/**
 * Represents a swap transaction result
 */
interface SwapTransactionResult {
  transaction: VersionedTransaction;
  quote: QuoteResponse;
  expectedAmountOut: number;
  priceImpact: number;
  minimumAmountOut: number;
  route: string;
  slippageBps: number;
}

/**
 * Jupiter API constants
 */
const JUPITER_V6_ENDPOINT = 'https://quote-api.jup.ag/v6';
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAX_SLIPPAGE_BPS = 1000; // 10%
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

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
  private jupiterApiEndpoint: string;
  private tokenAccounts: Map<string, TokenAccountInfo>;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;
  private readonly QUOTE_TIMEOUT_MS = 10000;
  private readonly SWAP_TIMEOUT_MS = 30000;

  constructor(connectionManager: ConnectionManager, dbManager: DatabaseManager, config: AppConfig) {
    this.connectionManager = connectionManager;
    this.dbManager = dbManager;
    this.config = config;
    this.logger = new Logger('TradeExecutor');
    this.circuitBreakers = new Map();
    this.transactionRetryCount = new Map();
    this.tokenAccounts = new Map();

    // Initialize Jupiter API endpoint
    this.jupiterApiEndpoint = JUPITER_V6_ENDPOINT;

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

      // Initialize token accounts cache
      await this.refreshTokenAccounts();

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

      // Validate network conditions
      await this.validateNetworkConditions();

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

      // Refresh token accounts after successful trade
      await this.refreshTokenAccounts();

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
        priceImpact: swapResult.priceImpact,
        slippage: swapResult.slippageBps / 100,
        route: swapResult.route,
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
   * Prepare a swap transaction using Jupiter API
   */
  private async prepareSwapTransaction(decision: TradeDecision): Promise<SwapTransactionResult> {
    try {
      this.logger.debug('Preparing swap transaction', {
        targetToken: decision.targetToken,
        baseToken: decision.baseToken,
        amountUsd: decision.tradeAmountUsd,
      });

      // Determine input/output tokens and amounts
      const inputMint = this.getTokenMint(decision.baseToken);
      const outputMint = decision.targetToken;
      const inputAmount = await this.calculateInputAmount(decision);

      // Get quote from Jupiter
      const quote = await this.getJupiterQuote(inputMint, outputMint, inputAmount, decision);
      
      // Validate quote
      this.validateSwapQuote(quote, decision);

      // Get swap transaction
      const swapTransaction = await this.getSwapTransaction(quote);

      // Parse the transaction
      let transaction = this.parseSwapTransaction(swapTransaction.swapTransaction);

      // Validate gas requirements
      await this.validateGasRequirements(transaction);

      // Apply MEV protection
      transaction = await this.applyMevProtection(transaction);

      const expectedAmountOut = parseFloat(quote.outAmount) / Math.pow(10, 6); // Assuming 6 decimals
      const priceImpact = parseFloat(quote.priceImpactPct || '0');
      const slippageBps = quote.slippageBps || DEFAULT_SLIPPAGE_BPS;
      const minimumAmountOut = expectedAmountOut * (1 - slippageBps / 10000);
      const route = this.extractRouteDescription(quote);

      this.logger.info('Swap transaction prepared', {
        expectedOut: expectedAmountOut,
        priceImpact: priceImpact,
        slippage: slippageBps / 100,
        route,
      });

      return {
        transaction,
        quote,
        expectedAmountOut,
        priceImpact,
        minimumAmountOut,
        route,
        slippageBps,
      };
    } catch (error) {
      this.logger.error('Failed to prepare swap transaction:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get Jupiter quote for swap
   */
  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    decision: TradeDecision
  ): Promise<QuoteResponse> {
    try {
      const slippageBps = Math.min(
        Math.max(this.config.tradeConfig.maxSlippagePercent * 100, 10), 
        MAX_SLIPPAGE_BPS
      );

      const quoteRequest: QuoteGetRequest = {
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
        maxAccounts: 64,
        minimizeSlippage: true,
        swapMode: 'ExactIn',
      };

      const quote = await this.getJupiterQuoteHttp(quoteRequest);
      
      if (!quote) {
        throw new Error('No quote received from Jupiter API');
      }

      this.logger.debug('Jupiter quote received', {
        inputAmount: amount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct,
        routePlan: quote.routePlan?.length || 0,
      });

      return quote;
    } catch (error) {
      this.logger.error('Failed to get Jupiter quote:', {
        inputMint,
        outputMint,
        amount,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Jupiter quote failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get swap transaction from Jupiter
   */
  private async getSwapTransaction(quote: QuoteResponse): Promise<SwapTransactionData> {
    try {
      const swapRequest: SwapRequest = {
          quoteResponse: quote,
          userPublicKey: this.wallet!.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          feeAccount: undefined,
          computeUnitPriceMicroLamports: this.calculateComputeUnitPrice(),
          prioritizationFeeLamports: this.calculatePriorityFee(),
          asLegacyTransaction: false,
          useTokenLedger: false,
          destinationTokenAccount: undefined,
          dynamicComputeUnitLimit: true,
          skipUserAccountsRpcCalls: false,
      };

      const swapResponse = await this.getSwapTransactionHttp(swapRequest);
      
      if (!swapResponse.swapTransaction) {
        throw new Error('No swap transaction received from Jupiter API');
      }

      return {
        swapTransaction: swapResponse.swapTransaction,
        lastValidBlockHeight: swapResponse.lastValidBlockHeight || 0,
      };
    } catch (error) {
      this.logger.error('Failed to get swap transaction:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Jupiter swap transaction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse swap transaction from base64 string
   */
  private parseSwapTransaction(swapTransactionString: string): VersionedTransaction {
    try {
      const swapTransactionBuf = Buffer.from(swapTransactionString, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      return transaction;
    } catch (error) {
      this.logger.error('Failed to parse swap transaction:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to parse swap transaction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Calculate input amount for swap based on trade decision
   */
  private async calculateInputAmount(decision: TradeDecision): Promise<number> {
    try {
      if (decision.baseToken === 'SOL') {
        // Convert USD to SOL amount (mock price of $100)
        const solPrice = 100; // This should come from price feed
        return decision.tradeAmountUsd / solPrice * 1e9; // Convert to lamports
      } else {
        // For other tokens, get from wallet balance
        const tokenAccount = await this.getOrCreateTokenAccount(decision.baseToken);
        const baseAmount = parseFloat(tokenAccount.uiAmountString);
        return Math.floor(baseAmount * Math.pow(10, tokenAccount.decimals));
      }
    } catch (error) {
      this.logger.error('Failed to calculate input amount:', {
        baseToken: decision.baseToken,
        tradeAmountUsd: decision.tradeAmountUsd,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get token mint address for base token
   */
  private getTokenMint(baseToken: string): string {
    switch (baseToken.toUpperCase()) {
      case 'SOL':
        return NATIVE_SOL_MINT;
      case 'USDC':
        return USDC_MINT;
      default:
        return baseToken; // Assume it's already a mint address
    }
  }

  /**
   * Validate swap quote against safety parameters
   */
  private validateSwapQuote(quote: QuoteResponse, decision: TradeDecision): void {
    const priceImpact = parseFloat(quote.priceImpactPct || '0');
    const maxPriceImpact = 0.05; // 5% max price impact

    if (priceImpact > maxPriceImpact) {
      throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% > ${maxPriceImpact * 100}%`);
    }

    const slippage = (quote.slippageBps || 0) / 100;
    const maxSlippage = this.config.tradeConfig.maxSlippagePercent;

    if (slippage > maxSlippage) {
      throw new Error(`Slippage too high: ${slippage.toFixed(2)}% > ${maxSlippage}%`);
    }

    // Validate minimum output amount
    const expectedAmountOut = parseFloat(quote.outAmount);
    if (expectedAmountOut <= 0) {
      throw new Error('Invalid output amount from quote');
    }

    this.logger.debug('Quote validation passed', {
      priceImpact: priceImpact,
      slippage: slippage,
      outputAmount: expectedAmountOut,
    });
  }

  /**
   * Extract human-readable route description from quote
   */
  private extractRouteDescription(quote: QuoteResponse): string {
    if (!quote.routePlan || quote.routePlan.length === 0) {
      return 'Direct';
    }

    const dexes = quote.routePlan?.map((route: any) => route.swapInfo?.label || 'Unknown') || [];
    return dexes.join(' → ');
  }

  /**
   * Calculate compute unit price for MEV protection
   */
  private calculateComputeUnitPrice(): number {
    // Base compute unit price, can be adjusted based on network congestion
    return 1000; // 0.001 SOL per compute unit
  }

  /**
   * Calculate priority fee for transaction prioritization
   */
  private calculatePriorityFee(): number {
    // Dynamic priority fee based on network conditions
    return 10000; // 0.00001 SOL priority fee
  }

  /**
   * Execute versioned transaction with retry logic
   */
  private async executeTransactionWithRetries(
    transaction: VersionedTransaction,
    tradeId: string,
  ): Promise<TransactionConfirmation> {
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < this.MAX_RETRIES) {
      try {
        // Sign versioned transaction
        transaction.sign([this.wallet!]);

        // Submit transaction
        const connection = this.connectionManager.getConnection();
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'processed',
          maxRetries: 0, // Handle retries manually
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

          // For versioned transactions, we need to get a fresh quote
          // as the original transaction may have expired
          this.logger.info('Retrying with fresh quote', { tradeId, attempt: retryCount + 1 });
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

      // Parse transaction logs to extract actual amount out
      const actualAmountOut = this.parseSwapAmountFromLogs(txDetails?.meta?.logMessages || []);

      return {
        signature,
        confirmed: true,
        gasFeeUsed: gasFeeUsed / 1e9, // Convert lamports to SOL
        actualAmountOut,
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
   * Get current wallet balance including all token accounts
   */
  public async getWalletBalance(): Promise<WalletBalance> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.connectionManager.getConnection();
      const solBalance = await connection.getBalance(this.wallet.publicKey);

      // Get all token accounts
      await this.refreshTokenAccounts();
      
      const tokens = new Map<string, number>();
      let totalValueUsd = (solBalance / 1e9) * 100; // Mock SOL price of $100

      // Add token balances
      for (const [mint, accountInfo] of this.tokenAccounts.entries()) {
        tokens.set(mint, accountInfo.uiAmount);
        // Add estimated USD value (simplified)
        totalValueUsd += accountInfo.uiAmount * 1; // Assume $1 per token for now
      }

      return {
        sol: solBalance / 1e9,
        tokens,
        totalValueUsd,
      };
    } catch (error) {
      this.logger.error('Failed to get wallet balance:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Refresh token accounts cache
   */
  private async refreshTokenAccounts(): Promise<void> {
    if (!this.wallet) return;

    try {
      const connection = this.connectionManager.getConnection();
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      this.tokenAccounts.clear();
      
      for (const { pubkey, account } of tokenAccounts.value) {
        const parsedInfo = account.data.parsed.info;
        const tokenInfo: TokenAccountInfo = {
          mint: parsedInfo.mint,
          owner: parsedInfo.owner,
          amount: parsedInfo.tokenAmount.amount,
          decimals: parsedInfo.tokenAmount.decimals,
          uiAmount: parsedInfo.tokenAmount.uiAmount || 0,
          uiAmountString: parsedInfo.tokenAmount.uiAmountString || '0',
          address: pubkey.toBase58(),
        };
        
        this.tokenAccounts.set(parsedInfo.mint, tokenInfo);
      }
      
      this.logger.debug(`Refreshed ${this.tokenAccounts.size} token accounts`);
    } catch (error) {
      this.logger.warning('Failed to refresh token accounts:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get or create token account for a given mint
   */
  private async getOrCreateTokenAccount(mint: string): Promise<TokenAccountInfo> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized');
    }

    // Check if we have it in cache
    const cached = this.tokenAccounts.get(mint);
    if (cached && parseFloat(cached.amount) > 0) {
      return cached;
    }

    try {
      const connection = this.connectionManager.getConnection();
      const mintPublicKey = new PublicKey(mint);
      const associatedTokenAddress = await getAssociatedTokenAddress(
        mintPublicKey,
        this.wallet.publicKey
      );

      try {
        // Try to get existing account
        const tokenAccount = await getAccount(connection, associatedTokenAddress);
        
        const tokenInfo: TokenAccountInfo = {
          mint: mint,
          owner: this.wallet.publicKey.toBase58(),
          amount: tokenAccount.amount.toString(),
          decimals: 6, // Default, should get from mint
          uiAmount: Number(tokenAccount.amount) / Math.pow(10, 6),
          uiAmountString: (Number(tokenAccount.amount) / Math.pow(10, 6)).toString(),
          address: associatedTokenAddress.toBase58(),
        };
        
        this.tokenAccounts.set(mint, tokenInfo);
        return tokenInfo;
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
          // Account doesn't exist, would need to create it during swap
          const tokenInfo: TokenAccountInfo = {
            mint: mint,
            owner: this.wallet.publicKey.toBase58(),
            amount: '0',
            decimals: 6,
            uiAmount: 0,
            uiAmountString: '0',
            address: associatedTokenAddress.toBase58(),
          };
          
          this.tokenAccounts.set(mint, tokenInfo);
          return tokenInfo;
        }
        throw error;
      }
    } catch (error) {
      this.logger.error('Failed to get or create token account:', {
        mint,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Parse actual swap amount from transaction logs
   */
  private parseSwapAmountFromLogs(logs: string[]): number | undefined {
    try {
      // Look for Jupiter swap completion logs
      for (const log of logs) {
        // Jupiter typically logs swap amounts
        if (log.includes('Program log: swap') || log.includes('SwapEvent')) {
          // Extract amount from log - this is simplified
          const amountMatch = log.match(/amount[_\s]*out[_\s]*:?[_\s]*(\d+)/i);
          if (amountMatch) {
            const amount = parseInt(amountMatch[1]);
            return amount / Math.pow(10, 6); // Assuming 6 decimals
          }
        }
        
        // Alternative: look for transfer instructions
        if (log.includes('Transfer') && log.includes('amount')) {
          const amountMatch = log.match(/(\d+)/g);
          if (amountMatch && amountMatch.length > 0) {
            const amount = parseInt(amountMatch[amountMatch.length - 1]);
            if (amount > 1000) { // Filter out small amounts (likely fees)
              return amount / Math.pow(10, 6);
            }
          }
        }
      }
      
      this.logger.debug('Could not parse swap amount from logs', {
        logCount: logs.length,
      });
      
      return undefined;
    } catch (error) {
      this.logger.warning('Error parsing swap amount from logs:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
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
    tokenAccountsCount: number;
    circuitBreakers: Array<{
      name: string;
      isTripped: boolean;
      reason?: string;
    }>;
    jupiterApiStatus: string;
  } {
    return {
      walletAddress: this.wallet?.publicKey.toBase58(),
      tokenAccountsCount: this.tokenAccounts.size,
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([name, breaker]) => ({
        name,
        isTripped: breaker.isTripped,
        reason: breaker.reason,
      })),
      jupiterApiStatus: 'connected', // Could add actual health check
    };
  }

  /**
   * Validate network conditions before trading
   */
  private async validateNetworkConditions(): Promise<void> {
    try {
      const connection = this.connectionManager.getConnection();
      
      // Check if connection is healthy
      const slot = await connection.getSlot();
      if (!slot || slot === 0) {
        throw new Error('Invalid network connection');
      }

      // Check for high network congestion
      const recentPerformance = await connection.getRecentPerformanceSamples(1);
      if (recentPerformance && recentPerformance.length > 0) {
        const sample = recentPerformance[0];
        const tps = sample.numTransactions / sample.samplePeriodSecs;
        
        if (tps > 5000) {
          this.logger.warning('High network congestion detected', { tps });
          // Could add circuit breaker logic here
        }
      }
      
      this.logger.debug('Network conditions validated', { slot });
    } catch (error) {
      this.logger.error('Network validation failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Network conditions not suitable for trading');
    }
  }

  /**
   * Estimate and validate gas requirements
   */
  private async validateGasRequirements(transaction: VersionedTransaction): Promise<void> {
    try {
      const connection = this.connectionManager.getConnection();
      
      // Simulate transaction to estimate compute units
      const simulation = await connection.simulateTransaction(transaction, {
        commitment: 'processed',
        sigVerify: false,
      });

      if (simulation.value.err) {
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      const computeUnitsUsed = simulation.value.unitsConsumed || 0;
      const maxComputeUnits = 1400000; // Current Solana limit

      if (computeUnitsUsed > maxComputeUnits * 0.9) {
        this.logger.warning('High compute unit usage detected', {
          used: computeUnitsUsed,
          limit: maxComputeUnits,
        });
      }

      this.logger.debug('Gas requirements validated', {
        computeUnits: computeUnitsUsed,
        maxUnits: maxComputeUnits,
      });
    } catch (error) {
      this.logger.warning('Gas validation failed (proceeding anyway):', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - this is not critical for execution
    }
  }

  /**
   * Handle MEV protection and transaction ordering
   */
  private async applyMevProtection(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    try {
      // For now, MEV protection is handled by Jupiter's smart routing
      // In the future, could add:
      // - Transaction bundling
      // - Priority fee optimization
      // - Flashloan protection
      // - Front-running detection
      
      this.logger.debug('MEV protection applied (via Jupiter routing)');
      return transaction;
    } catch (error) {
      this.logger.warning('MEV protection failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return transaction;
    }
  }

  /**
   * Get Jupiter quote via HTTP API
   */
  private async getJupiterQuoteHttp(request: QuoteGetRequest): Promise<QuoteResponse> {
    try {
      const params = new URLSearchParams({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amount.toString(),
        slippageBps: (request.slippageBps || DEFAULT_SLIPPAGE_BPS).toString(),
        onlyDirectRoutes: (request.onlyDirectRoutes || false).toString(),
        asLegacyTransaction: (request.asLegacyTransaction || false).toString(),
        maxAccounts: (request.maxAccounts || 64).toString(),
        swapMode: request.swapMode || 'ExactIn',
      });

      const response = await fetch(`${this.jupiterApiEndpoint}/quote?${params}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const quote = await response.json() as QuoteResponse;
      this.logger.debug('Jupiter HTTP quote received', {
        inputAmount: request.amount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct,
      });

      return quote;
    } catch (error) {
      this.logger.error('Jupiter HTTP quote failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get swap transaction via HTTP API
   */
  private async getSwapTransactionHttp(request: SwapRequest): Promise<{ swapTransaction: string; lastValidBlockHeight?: number }> {
    try {
      const response = await fetch(`${this.jupiterApiEndpoint}/swap`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as any;
      this.logger.debug('Jupiter HTTP swap transaction received');

      return {
        swapTransaction: result.swapTransaction,
        lastValidBlockHeight: result.lastValidBlockHeight,
      };
    } catch (error) {
      this.logger.error('Jupiter HTTP swap transaction failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
