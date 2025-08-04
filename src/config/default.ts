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
    // Advanced exit strategies (disabled by default)
    {
      type: 'trailing-stop',
      name: 'Trailing Stop Loss',
      description: 'Dynamic stop loss that trails behind the highest price',
      enabled: false,
      params: {
        initialStopPercent: 15,
        trailPercent: 10,
        activationPercent: 20,
        maxTrailAmount: 50,
      },
    },
    {
      type: 'volatility-stop',
      name: 'Volatility-Adjusted Stop',
      description: 'Stop loss that adjusts based on price volatility',
      enabled: false,
      params: {
        baseStopPercent: 15,
        volatilityMultiplier: 0.5,
        lookbackPeriodMinutes: 30,
        minStopPercent: 10,
        maxStopPercent: 25,
      },
    },
    {
      type: 'volume-based',
      name: 'Volume Exit Strategy',
      description: 'Exit based on trading volume changes',
      enabled: false,
      params: {
        minVolumeUsd: 1000,
        volumeDropThresholdPercent: 70,
        lookbackPeriodMinutes: 15,
        exitOnVolumeSpike: true,
        volumeSpikeMultiplier: 5,
      },
    },
    {
      type: 'multi-condition',
      name: 'Combined Exit Strategy',
      description: 'Exit when multiple conditions are met',
      enabled: false,
      params: {
        operator: 'OR',
        priority: 'HIGHEST_URGENCY',
        conditions: [
          {
            type: 'profit',
            enabled: true,
            params: {
              profitPercentage: 30,
            },
          },
          {
            type: 'trailing-stop',
            enabled: true,
            params: {
              initialStopPercent: 20,
              trailPercent: 15,
              activationPercent: 25,
            },
          },
        ],
      },
    },
    {
      type: 'partial-exit',
      name: 'Staged Exit Strategy',
      description: 'Exit positions in stages based on different conditions',
      enabled: false,
      params: {
        stages: [
          {
            triggerCondition: {
              type: 'profit',
              enabled: true,
              params: {
                profitPercentage: 25,
              },
            },
            exitPercentage: 30,
          },
          {
            triggerCondition: {
              type: 'profit',
              enabled: true,
              params: {
                profitPercentage: 50,
              },
            },
            exitPercentage: 50,
          },
          {
            triggerCondition: {
              type: 'profit',
              enabled: true,
              params: {
                profitPercentage: 100,
              },
            },
            exitPercentage: 100,
          },
        ],
        minStageGapPercent: 5,
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
  marketMonitoring: {
    enabled: true,
    priceVolatilityThreshold: 25, // 25% price volatility threshold
    volumeSpikeMultiplier: 3, // 3x volume spike multiplier
    liquidityDropThreshold: 30, // 30% liquidity drop threshold
    monitoringInterval: 30000, // Check every 30 seconds
    historicalDataWindow: 60, // 60 minutes of historical data
    circuitBreakerConfig: {
      failureThreshold: 3,
      successThreshold: 5,
      timeout: 60000, // 1 minute timeout
      monitoringPeriod: 300000, // 5 minute monitoring period
    },
  },
  riskManagement: {
    enabled: true,
    maxTotalExposure: 10000, // $10,000 maximum total exposure
    maxSinglePositionSize: 1000, // $1,000 maximum single position
    maxPortfolioPercentage: 50, // 50% maximum portfolio exposure
    maxConcentrationRisk: 30, // 30% maximum in correlated assets
    maxDailyLoss: 500, // $500 maximum daily loss
    maxDrawdown: 20, // 20% maximum drawdown
    volatilityMultiplier: 0.5, // Reduce position size by volatility * 0.5
    correlationThreshold: 0.7, // 70% correlation threshold
    rebalanceThreshold: 10, // 10% rebalance threshold
    riskAssessmentInterval: 60000, // Assess risk every minute
    emergencyExitThreshold: 15, // 15% emergency exit threshold
  },
  activeStrategy: 'default',
  logLevel: 'info',
  pollingInterval: 1000, // 1 second
  dryRun: false,
  verbose: false,
  disableTui: false,
};

export default defaultConfig;
