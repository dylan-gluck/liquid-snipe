import { AppConfig } from '../types';

const defaultConfig: AppConfig = {
  rpc: {
    httpUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    connectionTimeout: 30000, // 30 seconds
    commitment: 'confirmed',
    reconnectPolicy: {
      maxRetries: 5,
      baseDelay: 1000, // 1 second
      maxDelay: 60000, // 1 minute
    },
  },
  supportedDexes: [
    {
      name: 'Raydium',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      instructions: {
        newPoolCreation: 'initialize2',
        swap: 'swap',
        addLiquidity: 'addLiquidity',
        removeLiquidity: 'removeLiquidity',
      },
      enabled: true,
      priority: 1,
    },
    {
      name: 'Orca',
      programId: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
      instructions: {
        newPoolCreation: 'createPool',
        swap: 'swap',
      },
      enabled: false, // Disabled by default, can be enabled in custom config
      priority: 2,
    },
  ],
  wallet: {
    keypairPath: './keys/trading-wallet.json',
    riskPercent: 5, // Maximum percentage of wallet value per trade
    maxTotalRiskPercent: 20, // Maximum 20% of portfolio at risk at any time
    confirmationRequired: false,
    excludedTokens: [], // No excluded tokens by default
  },
  tradeConfig: {
    minLiquidityUsd: 1000, // Minimum liquidity threshold in USD
    maxSlippagePercent: 2,
    gasLimit: 0.01, // SOL
    defaultTradeAmountUsd: 100,
    maxTradeAmountUsd: 1000,
    minTokenPrice: 0.000001, // Minimum price in USD
    maxTokenSupply: 1000000000000, // Maximum supply
    maxHoldingTimeMinutes: 1440, // 24 hours max holding time
    requiredBaseTokens: [
      'So11111111111111111111111111111111111111112', // Wrapped SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ],
    minPoolAgeSeconds: 5, // Wait 5 seconds after pool creation before trading
  },
  exitStrategies: [
    {
      type: 'profit',
      name: 'Default Profit Strategy',
      description: 'Exit when profit reaches target percentage',
      enabled: true,
      params: {
        profitPercentage: 50, // Exit when profit reaches 50%
        trailingStopPercent: 5, // Use a 5% trailing stop
      },
    },
    {
      type: 'time',
      name: 'Time-based Exit',
      description: 'Exit after specified time has passed',
      enabled: true,
      params: {
        timeMinutes: 60, // Exit after 1 hour if no other condition met
      },
    },
    {
      type: 'loss',
      name: 'Stop Loss',
      description: 'Exit if loss reaches specified percentage',
      enabled: true,
      params: {
        lossPercentage: 20, // Exit if loss reaches 20%
      },
    },
    {
      type: 'liquidity',
      name: 'Liquidity Protection',
      description: 'Exit if liquidity drops below threshold',
      enabled: true,
      params: {
        minLiquidityUsd: 500,
        percentOfInitial: 50, // Exit if liquidity drops to 50% of initial
      },
    },
    {
      type: 'developer-activity',
      name: 'Dev Wallet Monitor',
      description: 'Exit if developer sells tokens',
      enabled: true,
      params: {
        monitorDeveloperWallet: true,
        exitOnSellPercentage: 10, // Exit if dev sells 10% or more
      },
    },
  ],
  database: {
    path: './data/liquid-snipe.db',
    backupIntervalHours: 24,
    maxBackups: 7,
    logToDatabase: true,
    pruneEventsOlderThanDays: 30,
  },
  notifications: {
    enabled: false,
    telegram: {
      enabled: false,
      notifyOnTrade: true,
      notifyOnPosition: true,
      notifyOnError: true,
    },
    discord: {
      enabled: false,
      notifyOnTrade: true,
      notifyOnPosition: true,
      notifyOnError: true,
    },
  },
  activeStrategy: 'default',
  logLevel: 'info',
  pollingInterval: 1000, // 1 second
  dryRun: false,
  verbose: false,
  disableTui: false,
};

export default defaultConfig;
