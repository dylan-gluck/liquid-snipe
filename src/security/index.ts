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

export {
  RiskManager,
  type RiskConfig,
  type RiskAssessment,
  type ExposureAnalysis,
  type CorrelationRisk,
  type VolatilityRisk,
  type LiquidityRisk,
  type RiskRecommendation,
  type RiskMetrics,
  type RiskAlert
} from './risk-manager';

// Hardware wallet exports
export {
  HardwareWalletInterface,
  HardwareWalletFactory,
  HardwareWalletInfo,
  ConnectionStatus,
  HardwareCapabilities,
  HardwareAccount,
  HardwareSigningOptions,
  HardwareSigningResult,
  HardwareWalletConfig,
  HardwareWalletError,
  HardwareWalletException,
  DEFAULT_HARDWARE_WALLET_CONFIG,
  LedgerAdapter,
  TrezorAdapter,
  MockAdapter,
  HardwareWalletFactoryImpl,
  HardwareWalletType,
  DetectionResult,
  createHardwareWalletFactory,
  getAvailableWalletTypes,
  isWalletTypeSupported,
  type LedgerConfig,
  type TrezorConfig,
  type MockAdapterConfig,
} from './hardware-wallet';