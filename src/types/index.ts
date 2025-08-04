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

export type ExitStrategyParams =
  | ProfitExitParams
  | TimeExitParams
  | LossExitParams
  | LiquidityExitParams
  | DeveloperActivityExitParams;

export interface ExitStrategyConfig {
  type: 'profit' | 'time' | 'loss' | 'liquidity' | 'developer-activity';
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

export interface AppConfig {
  rpc: RpcConfig;
  supportedDexes: DexConfig[];
  wallet: WalletConfig;
  tradeConfig: TradeConfig;
  exitStrategies: ExitStrategyConfig[];
  database: DatabaseConfig;
  notifications?: NotificationConfig;
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
