import {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
} from '@solana/web3.js';
import { BaseDexParser, PoolCreationInfo } from './base-parser';
import { DexConfig } from '../../types';

/**
 * Raydium DEX parser for AMM pool creation events
 * Program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 */
export class RaydiumParser extends BaseDexParser {
  // Raydium program IDs
  private static readonly RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  private static readonly RAYDIUM_LIQUIDITY_POOL_V4 = 'RVKd61ztZW9GUwhRbbLoYVRE5Xf1B2tVscKqwZqXgEr';

  // Pool creation instruction discriminators
  private static readonly INITIALIZE_DISCRIMINATOR = 'initialize';
  private static readonly INITIALIZE2_DISCRIMINATOR = 'initialize2';

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
      console.warn('Error parsing Raydium pool creation:', error);
      return null;
    }
  }

  isPoolCreationInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    dex: DexConfig
  ): boolean {
    // Check if it's a Raydium program instruction
    if (!this.isProgramInstruction(instruction, RaydiumParser.RAYDIUM_AMM_PROGRAM_ID)) {
      return false;
    }

    // Check for pool initialization methods
    return (
      this.containsMethod(instruction, RaydiumParser.INITIALIZE_DISCRIMINATOR) ||
      this.containsMethod(instruction, RaydiumParser.INITIALIZE2_DISCRIMINATOR) ||
      this.containsMethod(instruction, 'createAmm') ||
      this.containsMethod(instruction, 'initializeAmm')
    );
  }

  private extractPoolInfoFromInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      const accounts = this.getInstructionAccounts(instruction);
      
      if (accounts.length < 8) {
        // Fallback: try to extract from transaction accounts
        return this.extractFromTransactionAccounts(tx, dex);
      }

      // Raydium AMM account layout (typical positions):
      // 0: tokenProgram
      // 1: systemProgram  
      // 2: rent
      // 3: amm
      // 4: ammAuthority
      // 5: ammOpenOrders
      // 6: lpMint
      // 7: coinMint (tokenA)
      // 8: pcMint (tokenB)  
      // 9: coinVault
      // 10: pcVault
      // 11: withdrawQueue
      // 12: ammTargetOrders
      // 13: poolTempLp

      let poolAddress = '';
      let tokenA = '';
      let tokenB = '';

      // Extract pool address (AMM account)
      if (accounts.length > 3) {
        poolAddress = accounts[3];
      }

      // Extract token mints
      if (accounts.length > 8) {
        tokenA = accounts[7]; // coinMint
        tokenB = accounts[8]; // pcMint
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
        programId: RaydiumParser.RAYDIUM_AMM_PROGRAM_ID,
        instructionType: 'initialize_amm',
      };
    } catch (error) {
      console.warn('Error extracting Raydium pool info from instruction:', error);
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
        if (address !== RaydiumParser.RAYDIUM_AMM_PROGRAM_ID &&
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
        programId: RaydiumParser.RAYDIUM_AMM_PROGRAM_ID,
        instructionType: 'initialize_amm_fallback',
      };
    } catch (error) {
      console.warn('Error extracting Raydium pool info from transaction accounts:', error);
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