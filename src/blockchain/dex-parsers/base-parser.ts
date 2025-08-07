import {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
  PublicKey,
} from '@solana/web3.js';
import { DexConfig } from '../../types';

export interface DexParser {
  parsePoolCreation(tx: ParsedTransactionWithMeta, dex: DexConfig): PoolCreationInfo | null;
  isPoolCreationInstruction(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction, dex: DexConfig): boolean;
}

export interface PoolCreationInfo {
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  initialLiquidityUsd?: number;
  creator?: string;
  baseToken?: string;
  quoteToken?: string;
  programId: string;
  instructionType: string;
}

/**
 * Base class for DEX-specific parsers
 * Provides common utilities for instruction parsing
 */
export abstract class BaseDexParser implements DexParser {
  abstract parsePoolCreation(tx: ParsedTransactionWithMeta, dex: DexConfig): PoolCreationInfo | null;
  abstract isPoolCreationInstruction(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction, dex: DexConfig): boolean;

  /**
   * Check if instruction belongs to the specified program
   */
  protected isProgramInstruction(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction, programId: string): boolean {
    if ('program' in instruction) {
      return instruction.program === programId || instruction.programId?.toString() === programId;
    }
    if ('programId' in instruction) {
      return instruction.programId.toString() === programId;
    }
    return false;
  }

  /**
   * Extract account keys from instruction
   */
  protected getInstructionAccounts(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction): string[] {
    if ('accounts' in instruction && Array.isArray(instruction.accounts)) {
      return instruction.accounts.map(acc => typeof acc === 'string' ? acc : acc.toString());
    }
    return [];
  }

  /**
   * Get instruction data if available
   */
  protected getInstructionData(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction): string | null {
    if ('data' in instruction && typeof instruction.data === 'string') {
      return instruction.data;
    }
    return null;
  }

  /**
   * Check if instruction contains specific method name or discriminator
   */
  protected containsMethod(instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction, methodName: string): boolean {
    // Check parsed instruction type
    if ('parsed' in instruction && instruction.parsed?.type === methodName) {
      return true;
    }

    // Check instruction data for method discriminator
    const data = this.getInstructionData(instruction);
    if (data) {
      // Convert method name to potential discriminator patterns
      const methodLower = methodName.toLowerCase();
      return data.toLowerCase().includes(methodLower);
    }

    return false;
  }

  /**
   * Parse token amount from instruction data
   */
  protected parseTokenAmount(data: any, field: string = 'amount'): number | undefined {
    if (data && typeof data === 'object' && data[field]) {
      const amount = data[field];
      if (typeof amount === 'string') {
        return parseInt(amount, 10);
      }
      if (typeof amount === 'number') {
        return amount;
      }
    }
    return undefined;
  }

  /**
   * Validate that address is a valid PublicKey
   */
  protected isValidPublicKey(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract creator/signer from transaction
   */
  protected getTransactionSigner(tx: ParsedTransactionWithMeta): string | null {
    const accountKeys = tx.transaction.message.accountKeys;
    if (accountKeys.length > 0) {
      return accountKeys[0].pubkey.toString();
    }
    return null;
  }

  /**
   * Find token accounts from transaction
   */
  protected findTokenAccounts(tx: ParsedTransactionWithMeta): string[] {
    const tokenAccounts: string[] = [];
    
    // Check pre and post token balances
    if (tx.meta?.preTokenBalances) {
      for (const balance of tx.meta.preTokenBalances) {
        if (balance.mint) {
          tokenAccounts.push(balance.mint);
        }
      }
    }
    
    if (tx.meta?.postTokenBalances) {
      for (const balance of tx.meta.postTokenBalances) {
        if (balance.mint && !tokenAccounts.includes(balance.mint)) {
          tokenAccounts.push(balance.mint);
        }
      }
    }

    return tokenAccounts;
  }

  /**
   * Determine base and quote tokens from a pair
   */
  protected determineTokenPair(tokenA: string, tokenB: string): { baseToken: string; quoteToken: string } {
    // Common base tokens on Solana
    const commonBasesOrder = [
      'So11111111111111111111111111111111111111112', // WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ];

    for (const baseToken of commonBasesOrder) {
      if (tokenA === baseToken) {
        return { baseToken: tokenA, quoteToken: tokenB };
      }
      if (tokenB === baseToken) {
        return { baseToken: tokenB, quoteToken: tokenA };
      }
    }

    // Default: use lexicographical order
    return tokenA < tokenB 
      ? { baseToken: tokenA, quoteToken: tokenB }
      : { baseToken: tokenB, quoteToken: tokenA };
  }
}