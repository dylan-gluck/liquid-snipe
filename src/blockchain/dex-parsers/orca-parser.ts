import {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
} from '@solana/web3.js';
import { BaseDexParser, PoolCreationInfo } from './base-parser';
import { DexConfig } from '../../types';

/**
 * Orca DEX parser for Whirlpool creation events
 * Program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
 */
export class OrcaParser extends BaseDexParser {
  // Orca program IDs
  private static readonly ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  private static readonly ORCA_LEGACY_PROGRAM_ID = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP';

  // Pool creation instruction discriminators
  private static readonly INITIALIZE_POOL_DISCRIMINATOR = 'initializePool';
  private static readonly CREATE_POOL_DISCRIMINATOR = 'createPool';

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

      return null;
    } catch (error) {
      console.warn('Error parsing Orca pool creation:', error);
      return null;
    }
  }

  isPoolCreationInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    dex: DexConfig
  ): boolean {
    // Check if it's an Orca program instruction
    if (!this.isProgramInstruction(instruction, OrcaParser.ORCA_WHIRLPOOL_PROGRAM_ID) &&
        !this.isProgramInstruction(instruction, OrcaParser.ORCA_LEGACY_PROGRAM_ID)) {
      return false;
    }

    // Check for pool initialization methods
    return (
      this.containsMethod(instruction, OrcaParser.INITIALIZE_POOL_DISCRIMINATOR) ||
      this.containsMethod(instruction, OrcaParser.CREATE_POOL_DISCRIMINATOR) ||
      this.containsMethod(instruction, 'initializeWhirlpool') ||
      this.containsMethod(instruction, 'createWhirlpool')
    );
  }

  private extractPoolInfoFromInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      const accounts = this.getInstructionAccounts(instruction);
      
      if (accounts.length < 6) {
        // Fallback: try to extract from transaction accounts
        return this.extractFromTransactionAccounts(tx, dex);
      }

      // Orca Whirlpool account layout (typical positions):
      // 0: whirlpoolsConfig
      // 1: tokenMintA
      // 2: tokenMintB
      // 3: funder
      // 4: whirlpool (pool address)
      // 5: tokenVaultA
      // 6: tokenVaultB
      // 7: tickArrayLower
      // 8: tickArrayUpper
      // 9: feeTier
      // 10: tokenProgram
      // 11: systemProgram
      // 12: rent

      let poolAddress = '';
      let tokenA = '';
      let tokenB = '';

      // Try to extract from parsed instruction data first
      if ('parsed' in instruction && instruction.parsed?.info) {
        const info = instruction.parsed.info;
        if (info.tokenMintA) tokenA = info.tokenMintA;
        if (info.tokenMintB) tokenB = info.tokenMintB;
        if (info.whirlpool) poolAddress = info.whirlpool;
      }

      // Fallback to account positions
      if (!poolAddress || !tokenA || !tokenB) {
        if (accounts.length > 4) {
          poolAddress = accounts[4]; // whirlpool account
          tokenA = accounts[1]; // tokenMintA
          tokenB = accounts[2]; // tokenMintB
        }
      }

      // Validate extracted addresses
      if (!this.isValidPublicKey(poolAddress) || 
          !this.isValidPublicKey(tokenA) || 
          !this.isValidPublicKey(tokenB)) {
        return this.extractFromTransactionAccounts(tx, dex);
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
        programId: OrcaParser.ORCA_WHIRLPOOL_PROGRAM_ID,
        instructionType: 'initialize_whirlpool',
      };
    } catch (error) {
      console.warn('Error extracting Orca pool info from instruction:', error);
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

      // Look for newly created accounts or accounts with specific characteristics
      for (const accountKey of accountKeys) {
        const address = accountKey.pubkey.toString();
        // Skip known system programs and token accounts
        if (address !== OrcaParser.ORCA_WHIRLPOOL_PROGRAM_ID &&
            address !== OrcaParser.ORCA_LEGACY_PROGRAM_ID &&
            !tokenAccounts.includes(address) &&
            !this.isSystemProgram(address)) {
          poolAddress = address;
          break;
        }
      }

      if (!poolAddress || tokenAccounts.length < 2) {
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
        programId: OrcaParser.ORCA_WHIRLPOOL_PROGRAM_ID,
        instructionType: 'initialize_whirlpool_fallback',
      };
    } catch (error) {
      console.warn('Error extracting Orca pool info from transaction accounts:', error);
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
      '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c', // Orca Config
    ];
    
    return systemPrograms.includes(address);
  }
}