// Configuration Types
export interface RpcConfig {
  httpUrl: string;
  wsUrl: string;
  connectionTimeout?: number; // Milliseconds
  commitment?: 'processed' | 'confirmed' | 'finalized';
  reconnectPolicy?: {
    maxRetries: number;
    baseDelay: number; // Milliseconds
    maxDelay: number; // Milliseconds
  };
}

// Partial interface for easier patching in tests and overrides
export interface PartialRpcConfig extends Partial<RpcConfig> {}

export interface DexInstructionConfig {
  newPoolCreation: string;
  swap?: string;
  addLiquidity?: string;
  removeLiquidity?: string;
}

export interface DexConfig {
  name: string;
  programId: string;
  instructions: DexInstructionConfig;
  enabled: boolean;
  priority?: number; // Lower is higher priority
  customSettings?: Record<string, any>;
}

export interface WalletConfig {
  keypairPath: string;
  riskPercent: number;
  maxTotalRiskPercent?: number; // Maximum portfolio percentage at risk
  confirmationRequired?: boolean; // Require confirmation for trades
  excludedTokens?: string[]; // Addresses of tokens to exclude from trading
  hardwareWallet?: HardwareWalletConfig; // Hardware wallet configuration
}

export interface HardwareWalletConfig {
  enabled: boolean;
  preferredVendor?: 'ledger' | 'trezor';
  defaultDerivationPath: string;
  timeout: number;
  requireConfirmation: boolean;
  blindSigning: boolean;
  autoConnect: boolean;
  reconnectAttempts: number;
  reconnectDelay: number;
}

// Partial interface for easier patching in tests and overrides
export interface PartialWalletConfig extends Partial<WalletConfig> {}

export interface TradeConfig {
  minLiquidityUsd: number;
  maxSlippagePercent: number;
  gasLimit: number; // in SOL
  defaultTradeAmountUsd: number;
  maxTradeAmountUsd?: number;
  minTokenPrice?: number;
  maxTokenSupply?: number;
  maxHoldingTimeMinutes?: number;
  requiredBaseTokens?: string[]; // Allowed base tokens for trading (USDC, SOL, etc.)
  minPoolAgeSeconds?: number; // Minimum age of pool before trading
}

// Partial interface for easier patching in tests and overrides
export interface PartialTradeConfig extends Partial<TradeConfig> {}

export interface ProfitExitParams {
  profitPercentage: number;
  trailingStopPercent?: number;
}

export interface TimeExitParams {
  timeMinutes: number;
}

export interface LossExitParams {
  lossPercentage: number;
}

export interface LiquidityExitParams {
  minLiquidityUsd: number;
  percentOfInitial?: number;
}

export interface DeveloperActivityExitParams {
  monitorDeveloperWallet: boolean;
  exitOnSellPercentage?: number;
}

export interface MultiConditionExitParams {
  conditions: ExitStrategyConfig[];
  operator: 'AND' | 'OR';
  priority?: 'HIGHEST_URGENCY' | 'FIRST_MATCH' | 'ALL_CONDITIONS';
}

export interface TrailingStopLossParams {
  initialStopPercent: number;
  trailPercent: number;
  activationPercent?: number;
  maxTrailAmount?: number;
}

export interface VolatilityBasedStopParams {
  baseStopPercent: number;
  volatilityMultiplier: number;
  lookbackPeriodMinutes: number;
  minStopPercent?: number;
  maxStopPercent?: number;
}

export interface VolumeBasedExitParams {
  minVolumeUsd: number;
  volumeDropThresholdPercent: number;
  lookbackPeriodMinutes: number;
  exitOnVolumeSpike?: boolean;
  volumeSpikeMultiplier?: number;
}

export interface SentimentAnalysisParams {
  sources: ('social' | 'onchain' | 'technical')[];
  sentimentThreshold: number;
  confidenceThreshold: number;
  lookbackPeriodMinutes?: number;
}

export interface CreatorMonitoringParams {
  creatorWalletAddress?: string;
  autoDetectCreator: boolean;
  sellThresholdPercent: number;
  monitoringPeriodMinutes: number;
  exitOnFirstSell?: boolean;
}

export interface PartialExitParams {
  stages: {
    triggerCondition: ExitStrategyConfig;
    exitPercentage: number;
  }[];
  minStageGapPercent?: number;
}

export type ExitStrategyParams =
  | ProfitExitParams
  | TimeExitParams
  | LossExitParams
  | LiquidityExitParams
  | DeveloperActivityExitParams
  | MultiConditionExitParams
  | TrailingStopLossParams
  | VolatilityBasedStopParams
  | VolumeBasedExitParams
  | SentimentAnalysisParams
  | CreatorMonitoringParams
  | PartialExitParams;

export interface ExitStrategyConfig {
  type:
    | 'profit'
    | 'time'
    | 'loss'
    | 'liquidity'
    | 'developer-activity'
    | 'multi-condition'
    | 'trailing-stop'
    | 'volatility-stop'
    | 'volume-based'
    | 'sentiment-analysis'
    | 'creator-monitoring'
    | 'partial-exit';
  name?: string;
  description?: string;
  enabled: boolean;
  params: ExitStrategyParams;
}

export interface DatabaseConfig {
  path: string;
  backupIntervalHours?: number;
  maxBackups?: number;
  logToDatabase?: boolean;
  pruneEventsOlderThanDays?: number;
}

export interface NotificationConfig {
  enabled: boolean;
  telegram?: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    notifyOnTrade?: boolean;
    notifyOnPosition?: boolean;
    notifyOnError?: boolean;
  };
  discord?: {
    enabled: boolean;
    webhookUrl?: string;
    notifyOnTrade?: boolean;
    notifyOnPosition?: boolean;
    notifyOnError?: boolean;
  };
}

export interface MarketMonitoringConfig {
  enabled: boolean;
  priceVolatilityThreshold: number; // Percentage threshold for unusual price volatility
  volumeSpikeMultiplier: number; // Multiplier for unusual volume spikes
  liquidityDropThreshold: number; // Percentage drop in liquidity to trigger alert
  monitoringInterval: number; // Milliseconds between checks
  historicalDataWindow: number; // Minutes of historical data to consider
  circuitBreakerConfig: {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
    monitoringPeriod: number;
  };
}

export interface RiskManagementConfig {
  enabled: boolean;
  maxTotalExposure: number; // Maximum total USD exposure across all positions
  maxSinglePositionSize: number; // Maximum USD size for a single position
  maxPortfolioPercentage: number; // Maximum percentage of portfolio per position
  maxConcentrationRisk: number; // Maximum percentage in correlated assets
  maxDailyLoss: number; // Maximum daily loss before circuit breaker
  maxDrawdown: number; // Maximum drawdown percentage before shutdown
  volatilityMultiplier: number; // Position size adjustment based on volatility
  correlationThreshold: number; // Correlation threshold for risk grouping
  rebalanceThreshold: number; // Threshold for automatic rebalancing
  riskAssessmentInterval: number; // Milliseconds between risk assessments
  emergencyExitThreshold: number; // Emergency exit threshold percentage
}

export interface AppConfig {
  rpc: RpcConfig;
  supportedDexes: DexConfig[];
  wallet: WalletConfig;
  tradeConfig: TradeConfig;
  exitStrategies: ExitStrategyConfig[];
  database: DatabaseConfig;
  notifications?: NotificationConfig;
  marketMonitoring?: MarketMonitoringConfig;
  riskManagement?: RiskManagementConfig;
  dryRun: boolean;
  verbose: boolean;
  disableTui: boolean;
  activeStrategy?: string;
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
  pollingInterval?: number; // Milliseconds
}

// Flexible override interface for easier patching in tests and config overrides
export interface FlexibleAppConfig {
  rpc?: PartialRpcConfig;
  supportedDexes?: DexConfig[];
  wallet?: PartialWalletConfig;
  tradeConfig?: PartialTradeConfig;
  exitStrategies?: ExitStrategyConfig[];
  database?: Partial<DatabaseConfig>;
  notifications?: Partial<NotificationConfig>;
  marketMonitoring?: Partial<MarketMonitoringConfig>;
  riskManagement?: Partial<RiskManagementConfig>;
  dryRun?: boolean;
  verbose?: boolean;
  disableTui?: boolean;
  activeStrategy?: string;
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
  pollingInterval?: number;
}

// Event Types
export interface NewPoolEvent {
  signature: string;
  dex: string;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  timestamp: number;
}

export interface TradeDecision {
  shouldTrade: boolean;
  targetToken: string;
  baseToken: string;
  poolAddress: string;
  tradeAmountUsd: number;
  expectedAmountOut?: number;
  price?: number;
  reason: string;
  riskScore: number;
}

export interface TradeResult {
  success: boolean;
  signature?: string;
  tradeId?: string;
  positionId?: string;
  actualAmountOut?: number;
  error?: string;
  timestamp: number;
}

// Database Entity Types
export interface Token {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  firstSeen: number;
  isVerified: boolean;
  metadata: Record<string, any>;
}

export interface LiquidityPool {
  address: string;
  dexName: string;
  tokenA: string;
  tokenB: string;
  createdAt: number;
  initialLiquidityUsd: number;
  lastUpdated: number;
  currentLiquidityUsd: number;
}

export interface Trade {
  id: string;
  tokenAddress: string;
  poolAddress: string;
  direction: 'BUY' | 'SELL';
  amount: number;
  price: number;
  valueUsd: number;
  gasFeeUsd: number;
  timestamp: number;
  txSignature: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
}

export interface Position {
  id: string;
  tokenAddress: string;
  entryPrice: number;
  amount: number;
  openTimestamp: number;
  closeTimestamp?: number;
  entryTradeId: string;
  exitTradeId?: string;
  exitStrategy: ExitStrategyConfig;
  status: 'OPEN' | 'CLOSED';
  pnlUsd?: number;
  pnlPercent?: number;
}

export interface LogEvent {
  level: 'info' | 'warning' | 'error' | 'success' | 'debug';
  message: string;
  timestamp: number;
  data?: Record<string, any>;
}

// Additional data structures for advanced exit strategies
export interface PricePoint {
  price: number;
  timestamp: number;
  source: string;
}

export interface VolumeData {
  volumeUsd: number;
  timestamp: number;
  source: string;
}

export interface VolatilityMetrics {
  standardDeviation: number;
  averagePrice: number;
  priceRange: number;
  volatilityPercent: number;
  timestamp: number;
}

export interface TrendAnalysis {
  direction: 'UP' | 'DOWN' | 'SIDEWAYS';
  strength: number; // 0-100
  confidence: number; // 0-100
  timestamp: number;
}

export interface SentimentData {
  score: number; // -100 to 100
  confidence: number; // 0-100
  sources: string[];
  timestamp: number;
}

export interface CreatorActivity {
  walletAddress: string;
  transactionType: 'BUY' | 'SELL' | 'TRANSFER';
  amount: number;
  percentage: number; // Percentage of total holdings
  timestamp: number;
  txSignature: string;
}
