export { BaseDexParser, type DexParser, type PoolCreationInfo } from './base-parser';
export { RaydiumParser } from './raydium-parser';
export { OrcaParser } from './orca-parser';
export { JupiterParser } from './jupiter-parser';
export { GenericParser } from './generic-parser';

import { DexParser } from './base-parser';
import { RaydiumParser } from './raydium-parser';
import { OrcaParser } from './orca-parser';
import { JupiterParser } from './jupiter-parser';
import { GenericParser } from './generic-parser';
import { DexConfig } from '../../types';

/**
 * Factory function to create the appropriate parser for a given DEX
 */
export function createDexParser(dex: DexConfig): DexParser {
  const dexName = dex.name.toLowerCase();
  const programId = dex.programId;

  // Match by program ID first (most reliable)
  switch (programId) {
    case '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':
      return new RaydiumParser();
    case 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':
      return new OrcaParser();
    case 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':
    case 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB':
      return new JupiterParser();
  }

  // Fallback to name matching
  if (dexName.includes('raydium')) {
    return new RaydiumParser();
  } else if (dexName.includes('orca')) {
    return new OrcaParser();
  } else if (dexName.includes('jupiter')) {
    return new JupiterParser();
  }

  // Use generic parser for unknown DEXes
  return new GenericParser();
}

/**
 * Supported DEX program IDs
 */
export const SUPPORTED_DEX_PROGRAM_IDS = {
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  ORCA_LEGACY: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  JUPITER_V4: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
} as const;

/**
 * Get all supported program IDs as an array
 */
export function getSupportedProgramIds(): string[] {
  return Object.values(SUPPORTED_DEX_PROGRAM_IDS);
}

/**
 * Check if a program ID is supported
 */
export function isSupportedDex(programId: string): boolean {
  return getSupportedProgramIds().includes(programId);
}