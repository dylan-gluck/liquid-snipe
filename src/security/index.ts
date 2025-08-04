export { 
  TransactionSimulator,
  type SimulationResult,
  type SlippageValidation,
  type MEVProtectionAnalysis,
  type GasValidation,
  type TransactionSecurityConfig
} from './transaction-simulator';

export {
  SlippageProtection,
  type VolatilityMetrics,
  type MarketImpactEstimation,
  type DynamicSlippageResult,
  type AdaptiveSlippageLimits,
  type SlippageProtectionConfig
} from './slippage-protection';

export {
  SecureKeypairManager,
  type EncryptedKeypair,
  type SecureKeypairConfig,
  type SecurityValidationResult,
  type SigningOptions
} from './secure-keypair-manager';

export {
  EncryptedStorage,
  type EncryptedContainer,
  type EncryptedStorageConfig,
  type StorageResult,
  type IntegrityCheckResult
} from './encrypted-storage';