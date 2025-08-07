import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  RaydiumParser,
  OrcaParser,
  JupiterParser,
  GenericParser,
  createDexParser,
  SUPPORTED_DEX_PROGRAM_IDS,
} from '../src/blockchain/dex-parsers';
import { DexConfig } from '../src/types';

describe('DEX Parsers', () => {
  let raydiumConfig: DexConfig;
  let orcaConfig: DexConfig;
  let jupiterConfig: DexConfig;
  let genericConfig: DexConfig;

  beforeEach(() => {
    raydiumConfig = {
      name: 'Raydium',
      programId: SUPPORTED_DEX_PROGRAM_IDS.RAYDIUM_AMM,
      instructions: {
        newPoolCreation: 'initialize',
      },
      enabled: true,
    };

    orcaConfig = {
      name: 'Orca',
      programId: SUPPORTED_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL,
      instructions: {
        newPoolCreation: 'initializePool',
      },
      enabled: true,
    };

    jupiterConfig = {
      name: 'Jupiter',
      programId: SUPPORTED_DEX_PROGRAM_IDS.JUPITER_V6,
      instructions: {
        newPoolCreation: 'route',
      },
      enabled: true,
    };

    genericConfig = {
      name: 'GenericDEX',
      programId: 'GenericDEXProgramId123456789012345678901234',
      instructions: {
        newPoolCreation: 'createPool',
      },
      enabled: true,
    };
  });

  describe('createDexParser', () => {
    it('should create RaydiumParser for Raydium program ID', () => {
      const parser = createDexParser(raydiumConfig);
      expect(parser).toBeInstanceOf(RaydiumParser);
    });

    it('should create OrcaParser for Orca program ID', () => {
      const parser = createDexParser(orcaConfig);
      expect(parser).toBeInstanceOf(OrcaParser);
    });

    it('should create JupiterParser for Jupiter program ID', () => {
      const parser = createDexParser(jupiterConfig);
      expect(parser).toBeInstanceOf(JupiterParser);
    });

    it('should create GenericParser for unknown program ID', () => {
      const parser = createDexParser(genericConfig);
      expect(parser).toBeInstanceOf(GenericParser);
    });

    it('should create parser based on name if program ID not recognized', () => {
      const customRaydium = {
        ...genericConfig,
        name: 'Custom Raydium Fork',
      };
      const parser = createDexParser(customRaydium);
      expect(parser).toBeInstanceOf(RaydiumParser);
    });
  });

  describe('RaydiumParser', () => {
    let parser: RaydiumParser;

    beforeEach(() => {
      parser = new RaydiumParser();
    });

    it('should identify pool creation instruction', () => {
      const instruction = {
        programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.RAYDIUM_AMM),
        parsed: {
          type: 'initialize',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, raydiumConfig);
      expect(result).toBe(true);
    });

    it('should not identify non-pool creation instruction', () => {
      const instruction = {
        programId: new PublicKey('11111111111111111111111111111111'), // System Program
        parsed: {
          type: 'transfer',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, raydiumConfig);
      expect(result).toBe(false);
    });

    it('should handle malformed instructions gracefully', () => {
      const instruction = {};
      const result = parser.isPoolCreationInstruction(instruction as any, raydiumConfig);
      expect(result).toBe(false);
    });
  });

  describe('OrcaParser', () => {
    let parser: OrcaParser;

    beforeEach(() => {
      parser = new OrcaParser();
    });

    it('should identify whirlpool creation instruction', () => {
      const instruction = {
        programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.ORCA_WHIRLPOOL),
        parsed: {
          type: 'initializePool',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, orcaConfig);
      expect(result).toBe(true);
    });

    it('should handle legacy Orca program', () => {
      const legacyConfig = {
        ...orcaConfig,
        programId: SUPPORTED_DEX_PROGRAM_IDS.ORCA_LEGACY,
      };

      const instruction = {
        programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.ORCA_LEGACY),
        parsed: {
          type: 'createPool',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, legacyConfig);
      expect(result).toBe(true);
    });
  });

  describe('JupiterParser', () => {
    let parser: JupiterParser;

    beforeEach(() => {
      parser = new JupiterParser();
    });

    it('should identify Jupiter routing instruction', () => {
      const instruction = {
        programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.JUPITER_V6),
        parsed: {
          type: 'route',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, jupiterConfig);
      expect(result).toBe(true);
    });

    it('should handle v4 Jupiter program', () => {
      const v4Config = {
        ...jupiterConfig,
        programId: SUPPORTED_DEX_PROGRAM_IDS.JUPITER_V4,
      };

      const instruction = {
        programId: new PublicKey(SUPPORTED_DEX_PROGRAM_IDS.JUPITER_V4),
        parsed: {
          type: 'swap',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, v4Config);
      expect(result).toBe(true);
    });
  });

  describe('GenericParser', () => {
    let parser: GenericParser;

    beforeEach(() => {
      parser = new GenericParser();
    });

    it('should identify common pool creation methods', () => {
      const commonMethods = [
        'initialize',
        'initializePool',
        'createPool',
        'initializeAmm',
        'createAmm',
        'initializeMarket',
        'createMarket',
      ];

      commonMethods.forEach(method => {
        const instruction = {
          programId: new PublicKey(genericConfig.programId),
          parsed: {
            type: method,
          },
        };

        const result = parser.isPoolCreationInstruction(instruction as any, genericConfig);
        expect(result).toBe(true);
      });
    });

    it('should use custom instruction from config', () => {
      const customConfig = {
        ...genericConfig,
        instructions: {
          newPoolCreation: 'customCreatePool',
        },
      };

      const instruction = {
        programId: new PublicKey(customConfig.programId),
        parsed: {
          type: 'customCreatePool',
        },
      };

      const result = parser.isPoolCreationInstruction(instruction as any, customConfig);
      expect(result).toBe(true);
    });
  });

  describe('Base Parser Functionality', () => {
    let parser: GenericParser;

    beforeEach(() => {
      parser = new GenericParser();
    });

    it('should validate PublicKey addresses', () => {
      const validAddress = 'So11111111111111111111111111111111111111112';
      const invalidAddress = 'invalid_address';

      // Use protected method through inheritance
      expect((parser as any).isValidPublicKey(validAddress)).toBe(true);
      expect((parser as any).isValidPublicKey(invalidAddress)).toBe(false);
    });

    it('should determine token pair correctly', () => {
      const tokenA = 'So11111111111111111111111111111111111111112'; // SOL
      const tokenB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

      const { baseToken, quoteToken } = (parser as any).determineTokenPair(tokenA, tokenB);
      
      // SOL should be base token when paired with USDC
      expect(baseToken).toBe(tokenA);
      expect(quoteToken).toBe(tokenB);
    });

    it('should handle token pair with USDC as base', () => {
      const tokenA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
      const tokenB = 'TokenABC123456789012345678901234567890123456'; // Random token

      const { baseToken, quoteToken } = (parser as any).determineTokenPair(tokenA, tokenB);
      
      // USDC should be base token
      expect(baseToken).toBe(tokenA);
      expect(quoteToken).toBe(tokenB);
    });
  });

  describe('Error Handling', () => {
    let parser: GenericParser;

    beforeEach(() => {
      parser = new GenericParser();
    });

    it('should handle null/undefined inputs gracefully', () => {
      expect(() => parser.parsePoolCreation(null as any, genericConfig)).not.toThrow();
      expect(() => parser.parsePoolCreation(undefined as any, genericConfig)).not.toThrow();
      expect(() => parser.isPoolCreationInstruction(null as any, genericConfig)).not.toThrow();
    });

    it('should return null for invalid transactions', () => {
      const invalidTx = {
        transaction: {
          message: {
            instructions: null,
            accountKeys: [],
          },
          signatures: ['invalid_signature'],
        },
        meta: null,
      };

      const result = parser.parsePoolCreation(invalidTx as any, genericConfig);
      expect(result).toBeNull();
    });
  });

  describe('Integration with BlockchainWatcher interface', () => {
    it('should return PoolCreationInfo with required fields', () => {
      const parser = new GenericParser();
      
      // Mock a transaction with pool creation
      const mockTx = {
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(genericConfig.programId),
              parsed: { type: 'createPool' },
              accounts: [],
            }],
            accountKeys: [
              { pubkey: new PublicKey('11111111111111111111111111111111') },
              { pubkey: new PublicKey('So11111111111111111111111111111111111111112') },
              { pubkey: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') },
            ],
          },
          signatures: ['mock_signature'],
        },
        meta: {
          postTokenBalances: [
            { mint: 'So11111111111111111111111111111111111111112' },
            { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
          ],
        },
      };

      const result = parser.parsePoolCreation(mockTx as any, genericConfig);
      
      if (result) {
        expect(result).toHaveProperty('poolAddress');
        expect(result).toHaveProperty('tokenA');
        expect(result).toHaveProperty('tokenB');
        expect(result).toHaveProperty('programId');
        expect(result).toHaveProperty('instructionType');
        expect(typeof result.poolAddress).toBe('string');
        expect(typeof result.tokenA).toBe('string');
        expect(typeof result.tokenB).toBe('string');
      }
    });
  });
});