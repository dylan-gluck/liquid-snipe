#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigManager, ConfigValidationError } from './config';
import CoreController from './core/controller';
import { Logger } from './utils/logger';
import { AppConfig, DexConfig } from './types';

// Create a logger for the main process
const logger = new Logger('Main');

// Helper function to collect multiple option values
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Create the command line interface
const program = new Command();

program
  .name('liquid-snipe')
  .description('Solana trading bot that monitors for new liquidity pools and executes trades')
  .version('0.1.0');

program
  .option('-c, --config <path>', 'Custom config file path')
  .option('-s, --strategy <strategy>', 'Override active strategy')
  .option('--enable-dex <dex>', 'Enable a specific DEX (can be used multiple times)', collect, [])
  .option('--disable-dex <dex>', 'Disable a specific DEX (can be used multiple times)', collect, [])
  .option('-a, --amount <amount>', 'Override trade amount in USD')
  .option('--max-amount <amount>', 'Set maximum trade amount in USD')
  .option('-r, --risk <percentage>', 'Override risk percentage per trade')
  .option('--max-risk <percentage>', 'Set maximum total risk percentage')
  .option('-m, --min-liquidity <amount>', 'Override minimum liquidity in USD')
  .option('--rpc <url>', 'Override RPC HTTP URL')
  .option('--ws-rpc <url>', 'Override RPC WebSocket URL')
  .option('--keypair <path>', 'Override wallet keypair path')
  .option('--max-slippage <percentage>', 'Override maximum slippage percentage')
  .option('--gas-limit <amount>', 'Override gas limit in SOL')
  .option('--db-path <path>', 'Override database path')
  .option('--log-level <level>', 'Set log level (debug, info, warning, error)')
  .option('--notify <channel>', 'Enable notifications (telegram, discord, all)')
  .option('-d, --dry-run', 'Monitor only mode (no trading)')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('--disable-tui', 'Run without TUI (console logs only)')
  .option('--export-config <path>', 'Export current configuration to a file and exit')
  .action(async () => {
    await main();
  });

// Add export config command
program
  .command('export-config')
  .description('Export the default configuration to a file')
  .argument('<path>', 'Path to save the configuration file')
  .action((path: string) => {
    try {
      const configManager = new ConfigManager();
      configManager.saveToFile(path);
      logger.info(`Configuration exported to ${path}`);
      process.exit(0);
    } catch (error) {
      logger.error(`Failed to export configuration: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Add generate-keypair command
program
  .command('generate-keypair')
  .description('Generate a new Solana keypair for trading')
  .argument('<path>', 'Path to save the keypair file')
  .action((path: string) => {
    try {
      // TODO: Implement keypair generation when implementing the wallet module
      logger.info(`Keypair generation not yet implemented`);
      process.exit(0);
    } catch (error) {
      logger.error(`Failed to generate keypair: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Add validate-config command
program
  .command('validate-config')
  .description('Validate a configuration file')
  .argument('<path>', 'Path to the configuration file')
  .action((path: string) => {
    try {
      new ConfigManager(path);
      logger.info(`Configuration is valid: ${path}`);
      process.exit(0);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        logger.error(`Configuration validation failed: ${error.message}`);
      } else {
        logger.error(`Failed to validate configuration: ${(error as Error).message}`);
      }
      process.exit(1);
    }
  });

// Start the application
async function main(): Promise<void> {
  const options = program.opts();
  
  // Export configuration if requested
  if (options.exportConfig) {
    try {
      const configManager = new ConfigManager(options.config);
      
      // Apply any command line options first
      applyCommandLineOptions(configManager, options);
      
      // Save the configuration
      configManager.saveToFile(options.exportConfig);
      logger.info(`Configuration exported to ${options.exportConfig}`);
      process.exit(0);
    } catch (error) {
      logger.error(`Failed to export configuration: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  try {
    // Load configuration
    const configManager = new ConfigManager(options.config);
    
    // Apply command line overrides
    applyCommandLineOptions(configManager, options);
    
    // Get the final configuration
    const config = configManager.getConfig();
    
    // Initialize and start the controller
    const controller = new CoreController(config);
    
    // Initialize the application
    await controller.initialize();
    
    // Start the application
    await controller.start();
    
    // The application will continue running until shutdown
    logger.info('Liquid-Snipe is running. Press Ctrl+C to exit.');
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error(`Configuration validation failed: ${error.message}`);
    } else {
      logger.error(`Failed to start Liquid-Snipe: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}

// Parse command line arguments
program.parse();

// Apply command line options to the configuration
function applyCommandLineOptions(
  configManager: ConfigManager, 
  options: Record<string, any>
): void {
  const config = configManager.getConfig();
  const overrides: Partial<AppConfig> = {};

  // RPC Configuration
  if (options.rpc || options.wsRpc) {
    overrides.rpc = { ...config.rpc };
    if (options.rpc) overrides.rpc.httpUrl = options.rpc;
    if (options.wsRpc) overrides.rpc.wsUrl = options.wsRpc;
  }

  // Wallet Configuration
  if (options.keypair || options.risk || options.maxRisk) {
    overrides.wallet = { ...config.wallet };
    if (options.keypair) overrides.wallet.keypairPath = options.keypair;
    if (options.risk) overrides.wallet.riskPercent = parseFloat(options.risk);
    if (options.maxRisk) overrides.wallet.maxTotalRiskPercent = parseFloat(options.maxRisk);
  }

  // Trade Configuration
  if (
    options.amount ||
    options.maxAmount ||
    options.minLiquidity ||
    options.maxSlippage ||
    options.gasLimit
  ) {
    overrides.tradeConfig = { ...config.tradeConfig };
    if (options.amount) overrides.tradeConfig.defaultTradeAmountUsd = parseFloat(options.amount);
    if (options.maxAmount) overrides.tradeConfig.maxTradeAmountUsd = parseFloat(options.maxAmount);
    if (options.minLiquidity) overrides.tradeConfig.minLiquidityUsd = parseFloat(options.minLiquidity);
    if (options.maxSlippage) overrides.tradeConfig.maxSlippagePercent = parseFloat(options.maxSlippage);
    if (options.gasLimit) overrides.tradeConfig.gasLimit = parseFloat(options.gasLimit);
  }

  // Database Configuration
  if (options.dbPath) {
    overrides.database = { ...config.database, path: options.dbPath };
  }

  // DEX Configuration
  if (options.enableDex.length > 0 || options.disableDex.length > 0) {
    // Create a copy of the DEX configurations
    const dexConfigs: DexConfig[] = [...config.supportedDexes];
    
    // Enable specified DEXes
    options.enableDex.forEach((dexName: string) => {
      const dex = dexConfigs.find(d => d.name.toLowerCase() === dexName.toLowerCase());
      if (dex) {
        dex.enabled = true;
      } else {
        logger.warning(`Unknown DEX: ${dexName}`);
      }
    });
    
    // Disable specified DEXes
    options.disableDex.forEach((dexName: string) => {
      const dex = dexConfigs.find(d => d.name.toLowerCase() === dexName.toLowerCase());
      if (dex) {
        dex.enabled = false;
      } else {
        logger.warning(`Unknown DEX: ${dexName}`);
      }
    });
    
    overrides.supportedDexes = dexConfigs;
  }

  // Notification Configuration
  if (options.notify) {
    if (!config.notifications) {
      overrides.notifications = {
        enabled: true,
        telegram: { enabled: false },
        discord: { enabled: false },
      };
    } else {
      overrides.notifications = { ...config.notifications, enabled: true };
    }

    if (options.notify === 'telegram' || options.notify === 'all') {
      if (!overrides.notifications.telegram) {
        overrides.notifications.telegram = { enabled: true };
      } else {
        overrides.notifications.telegram = { ...overrides.notifications.telegram, enabled: true };
      }
    }

    if (options.notify === 'discord' || options.notify === 'all') {
      if (!overrides.notifications.discord) {
        overrides.notifications.discord = { enabled: true };
      } else {
        overrides.notifications.discord = { ...overrides.notifications.discord, enabled: true };
      }
    }
  }

  // General Configuration
  if (options.strategy) {
    overrides.activeStrategy = options.strategy;
  }

  if (options.logLevel) {
    overrides.logLevel = options.logLevel;
  }

  if (options.dryRun) {
    overrides.dryRun = true;
  }

  if (options.verbose) {
    overrides.verbose = true;
  }

  if (options.disableTui) {
    overrides.disableTui = true;
  }

  // Apply all overrides
  configManager.override(overrides);
}

