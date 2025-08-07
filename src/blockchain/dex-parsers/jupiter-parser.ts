import {
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
} from '@solana/web3.js';
import { BaseDexParser, PoolCreationInfo } from './base-parser';
import { DexConfig } from '../../types';

/**
 * Jupiter DEX parser for aggregator transactions that create pools
 * Program ID: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
 */
export class JupiterParser extends BaseDexParser {
  // Jupiter program IDs
  private static readonly JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  private static readonly JUPITER_V4_PROGRAM_ID = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB';

  // Pool creation instruction discriminators (Jupiter usually routes through other DEXes)
  private static readonly ROUTE_DISCRIMINATOR = 'route';
  private static readonly SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = 'sharedAccountsRoute';

  parsePoolCreation(tx: ParsedTransactionWithMeta, dex: DexConfig): PoolCreationInfo | null {
    try {
      // Jupiter is primarily an aggregator, so we need to look for underlying DEX pool creations
      // that Jupiter might be routing through or facilitating
      
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

      // Check inner instructions (more likely for Jupiter)
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

      // Jupiter-specific: Look for pool creation through routing
      return this.extractFromJupiterRouting(tx, dex);
    } catch (error) {
      console.warn('Error parsing Jupiter pool creation:', error);
      return null;
    }
  }

  isPoolCreationInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    dex: DexConfig
  ): boolean {
    // Check if it's a Jupiter program instruction
    if (!this.isProgramInstruction(instruction, JupiterParser.JUPITER_V6_PROGRAM_ID) &&
        !this.isProgramInstruction(instruction, JupiterParser.JUPITER_V4_PROGRAM_ID)) {
      return false;
    }

    // Jupiter itself doesn't create pools, but routes through other DEXes
    // Look for routing instructions that might involve new pools
    return (
      this.containsMethod(instruction, JupiterParser.ROUTE_DISCRIMINATOR) ||
      this.containsMethod(instruction, JupiterParser.SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR) ||
      this.containsMethod(instruction, 'swap') ||
      this.containsMethod(instruction, 'routeWithTokenLedger')
    );
  }

  private extractPoolInfoFromInstruction(
    instruction: ParsedInstruction | PartiallyDecodedInstruction | ParsedInnerInstruction,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Jupiter routing instructions contain information about pools being used
      const accounts = this.getInstructionAccounts(instruction);
      
      if (accounts.length < 4) {
        return null;
      }

      // Jupiter route instruction typically has:
      // Multiple accounts representing the routing path
      // We need to extract the specific pool being used in the route

      // Try to extract from parsed instruction data
      if ('parsed' in instruction && instruction.parsed?.info) {
        const info = instruction.parsed.info;
        // Jupiter parsed instructions might contain route information
        if (info.ammKey || info.marketKey) {
          return this.extractFromRouteInfo(info, tx, dex);
        }
      }

      // Look for pool-like accounts in the instruction
      return this.extractFromRoutingAccounts(accounts, tx, dex);
    } catch (error) {
      console.warn('Error extracting Jupiter pool info from instruction:', error);
      return null;
    }
  }

  private extractFromRouteInfo(
    routeInfo: any,
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      const poolAddress = routeInfo.ammKey || routeInfo.marketKey;
      const inputMint = routeInfo.inputMint;
      const outputMint = routeInfo.outputMint;

      if (!poolAddress || !inputMint || !outputMint) {
        return null;
      }

      if (!this.isValidPublicKey(poolAddress) || 
          !this.isValidPublicKey(inputMint) || 
          !this.isValidPublicKey(outputMint)) {
        return null;
      }

      const { baseToken, quoteToken } = this.determineTokenPair(inputMint, outputMint);
      const creator = this.getTransactionSigner(tx);

      return {
        poolAddress,
        tokenA: inputMint,
        tokenB: outputMint,
        baseToken,
        quoteToken,
        creator: creator || undefined,
        programId: JupiterParser.JUPITER_V6_PROGRAM_ID,
        instructionType: 'jupiter_route',
      };
    } catch (error) {
      console.warn('Error extracting from Jupiter route info:', error);
      return null;
    }
  }

  private extractFromRoutingAccounts(
    accounts: string[],
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Extract token accounts from token balances
      const tokenAccounts = this.findTokenAccounts(tx);
      
      if (tokenAccounts.length < 2) {
        return null;
      }

      // Find potential pool account from routing accounts
      let poolAddress = '';
      
      // Look for accounts that are not system programs or token mints
      for (const account of accounts) {
        if (!tokenAccounts.includes(account) && 
            !this.isSystemProgram(account) &&
            this.isValidPublicKey(account)) {
          poolAddress = account;
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
        programId: JupiterParser.JUPITER_V6_PROGRAM_ID,
        instructionType: 'jupiter_route_accounts',
      };
    } catch (error) {
      console.warn('Error extracting from Jupiter routing accounts:', error);
      return null;
    }
  }

  private extractFromJupiterRouting(
    tx: ParsedTransactionWithMeta,
    dex: DexConfig
  ): PoolCreationInfo | null {
    try {
      // Jupiter-specific logic to detect when it's facilitating pool creation
      // Look for specific patterns in logs or account changes
      
      const logs = tx.meta?.logMessages || [];
      
      // Look for pool creation logs in Jupiter transactions
      for (const log of logs) {
        if (log.includes('Initialize') && (log.includes('pool') || log.includes('Pool'))) {
          return this.extractFromTransactionAccounts(tx, dex);
        }
      }

      return null;
    } catch (error) {
      console.warn('Error extracting from Jupiter routing:', error);
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
        if (address !== JupiterParser.JUPITER_V6_PROGRAM_ID &&
            address !== JupiterParser.JUPITER_V4_PROGRAM_ID &&
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
        programId: JupiterParser.JUPITER_V6_PROGRAM_ID,
        instructionType: 'jupiter_facilitated_pool',
      };
    } catch (error) {
      console.warn('Error extracting Jupiter pool info from transaction accounts:', error);
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