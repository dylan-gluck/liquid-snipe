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