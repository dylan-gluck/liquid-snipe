import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { AppConfig, DexConfig, ExitStrategyConfig, FlexibleAppConfig } from '../types';
import defaultConfig from './default';
import { Logger } from '../utils/logger';
import { deepMerge } from '../utils/deep-merge';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigManager {
  private config: AppConfig;
  private logger: Logger;

  constructor(configPath?: string, envPrefix = 'LIQUID_SNIPE') {
    this.logger = new Logger('ConfigManager');

    // Start with default configuration
    this.config = defaultConfig;

    // Load configuration from file if specified
    if (configPath) {
      this.loadFromFile(configPath);
    }

    // Override with environment variables
    this.loadFromEnvironment(envPrefix);

    // Validate the configuration
    this.validate();
  }

  /**
   * Get the current configuration
   */
  public getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Override the current configuration with the provided values
   */
  public override(overrides: FlexibleAppConfig): void {
    this.config = deepMerge(this.config, overrides as Partial<AppConfig>);
    this.validate();
  }

  /**
   * Enable a DEX by name
   */
  public enableDex(dexName: string): boolean {
    const dex = this.config.supportedDexes.find(
      d => d.name.toLowerCase() === dexName.toLowerCase(),
    );
    if (dex) {
      dex.enabled = true;
      return true;
    }
    return false;
  }

  /**
   * Disable a DEX by name
   */
  public disableDex(dexName: string): boolean {
    const dex = this.config.supportedDexes.find(
      d => d.name.toLowerCase() === dexName.toLowerCase(),
    );
    if (dex) {
      dex.enabled = false;
      return true;
    }
    return false;
  }

  /**
   * Get a DEX configuration by name
   */
  public getDexConfig(dexName: string): DexConfig | undefined {
    return this.config.supportedDexes.find(d => d.name.toLowerCase() === dexName.toLowerCase());
  }

  /**
   * Get all enabled DEXes
   */
  public getEnabledDexes(): DexConfig[] {
    return this.config.supportedDexes.filter(d => d.enabled);
  }

  /**
   * Get an exit strategy configuration by name or type
   */
  public getExitStrategy(nameOrType: string): ExitStrategyConfig | undefined {
    // Try to find by name first (if available)
    const strategyByName = this.config.exitStrategies.find(
      s => s.name?.toLowerCase() === nameOrType.toLowerCase(),
    );

    if (strategyByName) {
      return strategyByName;
    }

    // Fallback to finding by type
    return this.config.exitStrategies.find(s => s.type.toLowerCase() === nameOrType.toLowerCase());
  }

  /**
   * Get all enabled exit strategies
   */
  public getEnabledExitStrategies(): ExitStrategyConfig[] {
    return this.config.exitStrategies.filter(s => s.enabled);
  }

  /**
   * Save the current configuration to a file
   */
  public saveToFile(filePath: string): void {
    try {
      const fileExtension = path.extname(filePath).toLowerCase();
      let fileContent: string;

      if (fileExtension === '.json') {
        fileContent = JSON.stringify(this.config, null, 2);
      } else if (fileExtension === '.yaml' || fileExtension === '.yml') {
        fileContent = yaml.dump(this.config);
      } else {
        throw new Error(`Unsupported file extension: ${fileExtension}`);
      }

      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, fileContent, 'utf8');
      this.logger.info(`Configuration saved to ${filePath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save configuration: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Load configuration from a file
   */
  private loadFromFile(configPath: string): void {
    try {
      if (!fs.existsSync(configPath)) {
        this.logger.warning(`Configuration file not found: ${configPath}`);
        return;
      }

      const fileExtension = path.extname(configPath).toLowerCase();
      const fileContent = fs.readFileSync(configPath, 'utf8');
      let fileConfig: Partial<AppConfig> = {};

      if (fileExtension === '.json') {
        fileConfig = JSON.parse(fileContent);
      } else if (fileExtension === '.yaml' || fileExtension === '.yml') {
        fileConfig = yaml.load(fileContent) as Partial<AppConfig>;
      } else if (fileExtension === '.js') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        fileConfig = require(path.resolve(configPath));
      } else {
        throw new Error(`Unsupported configuration file format: ${fileExtension}`);
      }

      this.config = deepMerge(this.config, fileConfig);
      this.logger.info(`Loaded configuration from ${configPath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load configuration from ${configPath}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnvironment(prefix: string): void {
    // Create a mapping of environment variable names to config paths
    const envVarMap: Record<string, string> = {
      // RPC Configuration
      [`${prefix}_RPC_HTTP_URL`]: 'rpc.httpUrl',
      [`${prefix}_RPC_WS_URL`]: 'rpc.wsUrl',
      [`${prefix}_RPC_TIMEOUT`]: 'rpc.connectionTimeout',
      [`${prefix}_RPC_COMMITMENT`]: 'rpc.commitment',

      // Wallet Configuration
      [`${prefix}_WALLET_KEYPAIR_PATH`]: 'wallet.keypairPath',
      [`${prefix}_WALLET_RISK_PERCENT`]: 'wallet.riskPercent',
      [`${prefix}_WALLET_MAX_TOTAL_RISK_PERCENT`]: 'wallet.maxTotalRiskPercent',
      [`${prefix}_WALLET_CONFIRMATION_REQUIRED`]: 'wallet.confirmationRequired',

      // Trade Configuration
      [`${prefix}_TRADE_MIN_LIQUIDITY_USD`]: 'tradeConfig.minLiquidityUsd',
      [`${prefix}_TRADE_MAX_SLIPPAGE_PERCENT`]: 'tradeConfig.maxSlippagePercent',
      [`${prefix}_TRADE_GAS_LIMIT`]: 'tradeConfig.gasLimit',
      [`${prefix}_TRADE_DEFAULT_AMOUNT_USD`]: 'tradeConfig.defaultTradeAmountUsd',
      [`${prefix}_TRADE_MAX_AMOUNT_USD`]: 'tradeConfig.maxTradeAmountUsd',
      [`${prefix}_TRADE_MIN_TOKEN_PRICE`]: 'tradeConfig.minTokenPrice',
      [`${prefix}_TRADE_MAX_TOKEN_SUPPLY`]: 'tradeConfig.maxTokenSupply',
      [`${prefix}_TRADE_MAX_HOLDING_TIME_MINUTES`]: 'tradeConfig.maxHoldingTimeMinutes',
      [`${prefix}_TRADE_MIN_POOL_AGE_SECONDS`]: 'tradeConfig.minPoolAgeSeconds',

      // Database Configuration
      [`${prefix}_DB_PATH`]: 'database.path',
      [`${prefix}_DB_BACKUP_INTERVAL_HOURS`]: 'database.backupIntervalHours',
      [`${prefix}_DB_MAX_BACKUPS`]: 'database.maxBackups',
      [`${prefix}_DB_LOG_TO_DATABASE`]: 'database.logToDatabase',
      [`${prefix}_DB_PRUNE_EVENTS_OLDER_THAN_DAYS`]: 'database.pruneEventsOlderThanDays',

      // Notification Configuration
      [`${prefix}_NOTIFICATIONS_ENABLED`]: 'notifications.enabled',
      [`${prefix}_TELEGRAM_ENABLED`]: 'notifications.telegram.enabled',
      [`${prefix}_TELEGRAM_BOT_TOKEN`]: 'notifications.telegram.botToken',
      [`${prefix}_TELEGRAM_CHAT_ID`]: 'notifications.telegram.chatId',
      [`${prefix}_DISCORD_ENABLED`]: 'notifications.discord.enabled',
      [`${prefix}_DISCORD_WEBHOOK_URL`]: 'notifications.discord.webhookUrl',

      // General Configuration
      [`${prefix}_ACTIVE_STRATEGY`]: 'activeStrategy',
      [`${prefix}_LOG_LEVEL`]: 'logLevel',
      [`${prefix}_POLLING_INTERVAL`]: 'pollingInterval',
      [`${prefix}_DRY_RUN`]: 'dryRun',
      [`${prefix}_VERBOSE`]: 'verbose',
      [`${prefix}_DISABLE_TUI`]: 'disableTui',
    };

    // Process each environment variable
    for (const [envVar, configPath] of Object.entries(envVarMap)) {
      if (process.env[envVar] !== undefined) {
        this.setConfigValue(configPath, process.env[envVar] as string);
      }
    }
  }

  /**
   * Set a configuration value from a string path
   */
  private setConfigValue(path: string, value: string): void {
    // Parse the path into an array of keys
    const keys = path.split('.');
    let current: any = this.config;

    // Navigate to the correct location in the config object
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] === undefined) {
        current[key] = {};
      }
      current = current[key];
    }

    // Set the value, converting to the appropriate type
    const lastKey = keys[keys.length - 1];
    const currentValue = current[lastKey];

    // Type conversion based on the existing value's type
    if (currentValue === undefined) {
      current[lastKey] = value;
    } else if (typeof currentValue === 'number') {
      current[lastKey] = Number(value);
    } else if (typeof currentValue === 'boolean') {
      current[lastKey] = value.toLowerCase() === 'true';
    } else if (Array.isArray(currentValue)) {
      try {
        current[lastKey] = JSON.parse(value);
      } catch (error) {
        current[lastKey] = value.split(',').map(item => item.trim());
      }
    } else {
      current[lastKey] = value;
    }
  }

  /**
   * Validate the configuration
   */
  private validate(): void {
    const errors: string[] = [];

    // Check RPC URLs
    if (!this.config.rpc.httpUrl) {
      errors.push('RPC HTTP URL is required');
    }

    if (!this.config.rpc.wsUrl) {
      errors.push('RPC WebSocket URL is required');
    }

    // Check wallet configuration
    if (!this.config.wallet.keypairPath) {
      errors.push('Wallet keypair path is required');
    }

    if (this.config.wallet.riskPercent <= 0 || this.config.wallet.riskPercent > 100) {
      errors.push('Wallet risk percentage must be between 0 and 100');
    }

    // Check trade configuration
    if (this.config.tradeConfig.minLiquidityUsd <= 0) {
      errors.push('Minimum liquidity must be greater than 0');
    }

    if (
      this.config.tradeConfig.maxSlippagePercent <= 0 ||
      this.config.tradeConfig.maxSlippagePercent > 100
    ) {
      errors.push('Max slippage percentage must be between 0 and 100');
    }

    if (this.config.tradeConfig.gasLimit <= 0) {
      errors.push('Gas limit must be greater than 0');
    }

    if (this.config.tradeConfig.defaultTradeAmountUsd <= 0) {
      errors.push('Default trade amount must be greater than 0');
    }

    // Check for enabled DEXes
    if (!this.config.supportedDexes.some(d => d.enabled)) {
      errors.push('At least one DEX must be enabled');
    }

    // Check for enabled exit strategies
    if (!this.config.exitStrategies.some(s => s.enabled)) {
      errors.push('At least one exit strategy must be enabled');
    }

    // Check database path
    if (!this.config.database.path) {
      errors.push('Database path is required');
    }

    // Fail if there are any validation errors
    if (errors.length > 0) {
      const errorMessage = `Configuration validation failed:\n- ${errors.join('\n- ')}`;
      this.logger.error(errorMessage);
      throw new ConfigValidationError(errorMessage);
    }
  }
}

// Export a singleton instance
export const configManager = new ConfigManager();
export default configManager;
