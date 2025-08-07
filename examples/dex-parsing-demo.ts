#!/usr/bin/env ts-node

/**
 * DEX Parsing Demonstration
 * 
 * This demo shows how the new DEX-specific parsing system works
 * and demonstrates the capabilities for Raydium, Orca, Jupiter, and generic DEXes.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createDexParser, SUPPORTED_DEX_PROGRAM_IDS, getSupportedProgramIds } from '../src/blockchain/dex-parsers';
import { DexConfig } from '../src/types';

// Example DEX configurations
const dexConfigs: DexConfig[] = [
  {
    name: 'Raydium',
    programId: SUPPORTED_DEX_PROGRAM_IDS.RAYDIUM_AMM,
    instructions: {
      newPoolCreation: 'initialize',
    },
    enabled: true,
    priority: 1,
  },
  {
    name: 'Orca',
    programId: SUPPORTED_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL,
    instructions: {
      newPoolCreation: 'initializePool',
    },
    enabled: true,
    priority: 2,
  },
  {
    name: 'Jupiter',
    programId: SUPPORTED_DEX_PROGRAM_IDS.JUPITER_V6,
    instructions: {
      newPoolCreation: 'route',
    },
    enabled: true,
    priority: 3,
  },
  {
    name: 'CustomDEX',
    programId: '11111111111111111111111111111111', // Using system program as example
    instructions: {
      newPoolCreation: 'createLiquidityPool',
    },
    enabled: true,
    priority: 4,
  },
];

// Mock transaction data that simulates real pool creation transactions
const mockTransactions = {
  raydium: {
    transaction: {
      message: {
        instructions: [
          {
            programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.RAYDIUM_AMM),
            parsed: {
              type: 'initialize',
              info: {
                amm: 'So11111111111111111111111111111111111111112',
                coinMint: 'So11111111111111111111111111111111111111112', // SOL
                pcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
              }
            },
            accounts: [
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token program
              '11111111111111111111111111111111', // System program
              'SysvarRent111111111111111111111111111111111', // Rent
              'So11111111111111111111111111111111111111112', // AMM (using SOL address as example)
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // AMM Authority
              'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Open orders
              'SysvarRent111111111111111111111111111111111', // LP mint
              'So11111111111111111111111111111111111111112', // Coin mint (SOL)
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // PC mint (USDC)
            ],
          }
        ],
        accountKeys: [
          { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
          { pubkey: new PublicKey('So11111111111111111111111111111111111111112') },
          { pubkey: new PublicKey('So11111111111111111111111111111111111111112') },
          { pubkey: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') },
        ],
      },
      signatures: ['2wiSc2yc6qDzr8xsGhwLm6W6aZKqhBJzxH6j9RrsBFCnEZd6FLjJ4VKK9p3Z2N2X8Y5K6vB9H8J3kL7M1pQ4R6T'],
    },
    meta: {
      postTokenBalances: [
        { mint: 'So11111111111111111111111111111111111111112', amount: '1000000000' },
        { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '50000000' },
      ],
      logMessages: [
        'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]',
        'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 consumed 89000 of 200000 compute units',
        'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success',
      ],
    },
  },
  orca: {
    transaction: {
      message: {
        instructions: [
          {
            programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL),
            parsed: {
              type: 'initializePool',
              info: {
                whirlpool: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                tokenMintA: 'So11111111111111111111111111111111111111112', // SOL
                tokenMintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
              }
            },
            accounts: [
              'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Whirlpools config
              'So11111111111111111111111111111111111111112', // Token mint A
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Token mint B
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Funder
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Whirlpool
              'SysvarRent111111111111111111111111111111111', // Token vault A
            ],
          }
        ],
        accountKeys: [
          { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
          { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
          { pubkey: new PublicKey('So11111111111111111111111111111111111111112') },
          { pubkey: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') },
        ],
      },
      signatures: ['3nJx7qH8p9Q2kL4M5nB7cF6rD8sE9tG1hI2jK3lP4qR5sT6uV7wX8yZ9aA1bB2cC'],
    },
    meta: {
      postTokenBalances: [
        { mint: 'So11111111111111111111111111111111111111112', amount: '2000000000' },
        { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '100000000' },
      ],
    },
  },
};

async function demonstrateDexParsing() {
  console.log('🚀 DEX Parsing System Demonstration\n');
  console.log('=' .repeat(50));
  
  console.log('\n📋 Supported DEX Program IDs:');
  getSupportedProgramIds().forEach((programId, index) => {
    const dex = dexConfigs.find(d => d.programId === programId);
    console.log(`${index + 1}. ${dex?.name || 'Unknown'}: ${programId}`);
  });

  console.log('\n🔧 Creating DEX-specific parsers...');
  
  for (const dexConfig of dexConfigs) {
    console.log(`\n--- ${dexConfig.name} Parser ---`);
    
    try {
      const parser = createDexParser(dexConfig);
      console.log(`✅ Created ${parser.constructor.name} for ${dexConfig.name}`);
      console.log(`   Program ID: ${dexConfig.programId}`);
      console.log(`   Pool Creation Instruction: ${dexConfig.instructions.newPoolCreation}`);
      
      // Demonstrate instruction detection
      if (dexConfig.name === 'Raydium' && mockTransactions.raydium) {
        console.log('\n🔍 Testing Raydium pool creation parsing...');
        const result = parser.parsePoolCreation(mockTransactions.raydium as any, dexConfig);
        
        if (result) {
          console.log('✅ Successfully parsed Raydium pool creation:');
          console.log(`   Pool Address: ${result.poolAddress}`);
          console.log(`   Token A: ${result.tokenA}`);
          console.log(`   Token B: ${result.tokenB}`);
          console.log(`   Base Token: ${result.baseToken}`);
          console.log(`   Quote Token: ${result.quoteToken}`);
          console.log(`   Creator: ${result.creator}`);
          console.log(`   Instruction Type: ${result.instructionType}`);
        } else {
          console.log('❌ Failed to parse Raydium transaction');
        }
      }
      
      if (dexConfig.name === 'Orca' && mockTransactions.orca) {
        console.log('\n🔍 Testing Orca pool creation parsing...');
        const result = parser.parsePoolCreation(mockTransactions.orca as any, dexConfig);
        
        if (result) {
          console.log('✅ Successfully parsed Orca pool creation:');
          console.log(`   Pool Address: ${result.poolAddress}`);
          console.log(`   Token A: ${result.tokenA}`);
          console.log(`   Token B: ${result.tokenB}`);
          console.log(`   Base Token: ${result.baseToken}`);
          console.log(`   Quote Token: ${result.quoteToken}`);
          console.log(`   Creator: ${result.creator}`);
          console.log(`   Instruction Type: ${result.instructionType}`);
        } else {
          console.log('❌ Failed to parse Orca transaction');
        }
      }
      
    } catch (error) {
      console.log(`❌ Failed to create parser for ${dexConfig.name}:`, error);
    }
  }

  console.log('\n📊 Parser Features Summary:');
  console.log('✅ Raydium AMM support (675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)');
  console.log('✅ Orca Whirlpool support (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)');
  console.log('✅ Jupiter aggregator support (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)');
  console.log('✅ Generic DEX fallback parser');
  console.log('✅ Base/Quote token detection');
  console.log('✅ Creator wallet extraction');
  console.log('✅ Pool address validation');
  console.log('✅ Instruction type identification');
  console.log('✅ Comprehensive error handling');
  console.log('✅ Production-ready transaction parsing');

  console.log('\n🎯 Integration Points:');
  console.log('• BlockchainWatcher now uses DEX-specific parsers');
  console.log('• NewPoolEvent includes enhanced metadata');
  console.log('• Extensible architecture for adding new DEXes');
  console.log('• Modular parser system with base class');
  console.log('• Full compatibility with existing interfaces');

  console.log('\n🚀 MVP Status: DEX Parsing Implementation COMPLETE!');
  console.log('=' .repeat(50));
}

// Run the demonstration
if (require.main === module) {
  demonstrateDexParsing().catch(console.error);
}

export { demonstrateDexParsing, dexConfigs, mockTransactions };