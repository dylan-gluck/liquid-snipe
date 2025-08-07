import {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
} from '@solana/web3.js';
import { BaseDexParser, PoolCreationInfo } from './base-parser';
import { DexConfig } from '../../types';

/**
 * Generic DEX parser for unknown or custom DEXes
 * Uses heuristics to detect pool creation patterns
 */
export class GenericParser extends BaseDexParser {
  // Common pool creation method names
  private static readonly POOL_CREATION_METHODS = [
    'initialize',
    'initializePool',
    'createPool',
    'initializeAmm',
    'createAmm',
    'initializeMarket',
    'createMarket',
    'initializePair',
    'createPair',
  ];

  parsePoolCreation(tx: ParsedTransactionWithMeta, dex: DexConfig): PoolCreationInfo | null {
    try {
      // Check all instructions in the transaction
      if (tx.transaction.message.instructions) {
        for (const instruction of tx.transaction.message.instructions) {
          if (this.isPoolCreationInstruction(instruction, dex)) {
            const poolInfo = this.extractPoolInfoFromInstruction(instruction, tx, dex);
            if (poolInfo) {
              return poolInfo;
            }
          }
        }
      }

      // Check inner instructions
      if (tx.meta?.innerInstructions) {
        for (const innerInstructionSet of tx.meta.innerInstructions) {
          for (const innerInstruction of innerInstructionSet.instructions) {
            if (this.isPoolCreationInstruction(innerInstruction, dex)) {
              const poolInfo = this.extractPoolInfoFromInstruction(innerInstruction, tx, dex);
              if (poolInfo) {
                return poolInfo;
              }
            }
          }
        }
      }

      // Fallback: use heuristic detection
      return this.heuristicPoolDetection(tx, dex);
    } catch (error) {
      console.warn('Error parsing generic pool creation:', error);
      return null;
    }
  }

  isPoolCreationInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    dex: DexConfig
  ): boolean {
    // Check if it's the specified program instruction
    if (!this.isProgramInstruction(instruction, dex.programId)) {
      return false;
    }

    // Check for common pool creation methods
    for (const method of GenericParser.POOL_CREATION_METHODS) {
      if (this.containsMethod(instruction, method)) {
        return true;
      }
    }

    // Check for custom instruction from dex config
    if (dex.instructions.newPoolCreation) {
      return this.containsMethod(instruction, dex.instructions.newPoolCreation);
    }

    return false;
  }

  private extractPoolInfoFromInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      const accounts = this.getInstructionAccounts(instruction);
      
      if (accounts.length < 3) {
        return this.extractFromTransactionAccounts(tx, dex);
      }

      // Try to extract from parsed instruction data first
      if ('parsed' in instruction && instruction.parsed?.info) {
        const poolInfo = this.extractFromParsedInfo(instruction.parsed.info, tx, dex);
        if (poolInfo) {
          return poolInfo;
        }
      }

      // Generic account extraction heuristics
      return this.extractFromGenericAccounts(accounts, tx, dex);
    } catch (error) {
      console.warn('Error extracting generic pool info from instruction:', error);
      return null;
    }
  }

  private extractFromParsedInfo(
    info: any,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Common field names for pool information
      const poolFields = ['pool', 'poolAccount', 'market', 'pair', 'amm'];
      const tokenAFields = ['tokenA', 'tokenMintA', 'coinMint', 'baseMint', 'mint0'];
      const tokenBFields = ['tokenB', 'tokenMintB', 'pcMint', 'quoteMint', 'mint1'];

      let poolAddress = '';
      let tokenA = '';
      let tokenB = '';

      // Extract pool address
      for (const field of poolFields) {
        if (info[field]) {
          poolAddress = info[field];
          break;
        }
      }

      // Extract token A
      for (const field of tokenAFields) {
        if (info[field]) {
          tokenA = info[field];
          break;
        }
      }

      // Extract token B
      for (const field of tokenBFields) {
        if (info[field]) {
          tokenB = info[field];
          break;
        }
      }

      if (!poolAddress || !tokenA || !tokenB) {
        return null;
      }

      if (!this.isValidPublicKey(poolAddress) || 
          !this.isValidPublicKey(tokenA) || 
          !this.isValidPublicKey(tokenB)) {
        return null;
      }

      const { baseToken, quoteToken } = this.determineTokenPair(tokenA, tokenB);
      const creator = this.getTransactionSigner(tx);

      return {
        poolAddress,
        tokenA,
        tokenB,
        baseToken,
        quoteToken,
        creator: creator || undefined,
        programId: dex.programId,
        instructionType: 'generic_parsed',
      };
    } catch (error) {
      console.warn('Error extracting from parsed info:', error);
      return null;
    }
  }

  private extractFromGenericAccounts(
    accounts: string[],
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Generic heuristic: assume first few accounts contain pool and token information
      const tokenAccounts = this.findTokenAccounts(tx);
      
      if (tokenAccounts.length < 2) {
        return null;
      }

      // Look for pool account in instruction accounts
      let poolAddress = '';
      
      for (const account of accounts) {
        if (!tokenAccounts.includes(account) && 
            !this.isSystemProgram(account) &&
            account !== dex.programId &&
            this.isValidPublicKey(account)) {
          poolAddress = account;
          break;
        }
      }

      if (!poolAddress) {
        // Use first account as pool address if no other suitable candidate
        poolAddress = accounts[0];
      }

      const tokenA = tokenAccounts[0];
      const tokenB = tokenAccounts[1];
      const { baseToken, quoteToken } = this.determineTokenPair(tokenA, tokenB);
      const creator = this.getTransactionSigner(tx);

      return {
        poolAddress,
        tokenA,
        tokenB,
        baseToken,
        quoteToken,
        creator: creator || undefined,
        programId: dex.programId,
        instructionType: 'generic_accounts',
      };
    } catch (error) {
      console.warn('Error extracting from generic accounts:', error);
      return null;
    }
  }

  private heuristicPoolDetection(
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Use transaction-level heuristics to detect pool creation
      const logs = tx.meta?.logMessages || [];
      
      // Look for pool creation indicators in logs
      const poolCreationIndicators = [
        'Initialize',
        'Pool created',
        'Market created',
        'AMM initialized',
        'Pair created',
      ];

      let hasPoolCreationLog = false;
      for (const log of logs) {
        for (const indicator of poolCreationIndicators) {
          if (log.includes(indicator)) {
            hasPoolCreationLog = true;
            break;
          }
        }
        if (hasPoolCreationLog) break;
      }

      if (!hasPoolCreationLog) {
        return null;
      }

      return this.extractFromTransactionAccounts(tx, dex);
    } catch (error) {
      console.warn('Error in heuristic pool detection:', error);
      return null;
    }
  }

  private extractFromTransactionAccounts(
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Extract token accounts from token balances
      const tokenAccounts = this.findTokenAccounts(tx);
      
      if (tokenAccounts.length < 2) {
        return null;
      }

      // Find potential pool account from account keys
      const accountKeys = tx.transaction.message.accountKeys;
      let poolAddress = '';

      // Look for newly created accounts
      for (const accountKey of accountKeys) {
        const address = accountKey.pubkey.toString();
        if (address !== dex.programId &&
            !tokenAccounts.includes(address) &&
            !this.isSystemProgram(address)) {
          poolAddress = address;
          break;
        }
      }

      if (!poolAddress) {
        return null;
      }

      const tokenA = tokenAccounts[0];
      const tokenB = tokenAccounts[1];
      const { baseToken, quoteToken } = this.determineTokenPair(tokenA, tokenB);
      const creator = this.getTransactionSigner(tx);

      return {
        poolAddress,
        tokenA,
        tokenB,
        baseToken,
        quoteToken,
        creator: creator || undefined,
        programId: dex.programId,
        instructionType: 'generic_heuristic',
      };
    } catch (error) {
      console.warn('Error extracting generic pool info from transaction accounts:', error);
      return null;
    }
  }

  private isSystemProgram(address: string): boolean {
    const systemPrograms = [
      '11111111111111111111111111111111', // System Program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token Program 2022
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
      'SysvarRent111111111111111111111111111111111', // Rent Sysvar
      'SysvarC1ock11111111111111111111111111111111', // Clock Sysvar
    ];
    
    return systemPrograms.includes(address);
  }
}