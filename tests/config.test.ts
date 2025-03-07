import { ConfigManager } from '../src/config';
import defaultConfig from '../src/config/default';

describe('Configuration Manager', () => {
  it('should load default configuration', () => {
    const configManager = new ConfigManager();
    const config = configManager.getConfig();
    
    expect(config).toEqual(defaultConfig);
    expect(config.rpc.httpUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(config.supportedDexes.length).toBeGreaterThan(0);
  });

  it('should override configuration values', () => {
    const configManager = new ConfigManager();
    
    const overrides = {
      dryRun: true,
      verbose: true,
      tradeConfig: {
        ...defaultConfig.tradeConfig,
        minLiquidityUsd: 2000,
        defaultTradeAmountUsd: 200,
      },
    };
    
    configManager.override(overrides);
    const config = configManager.getConfig();
    
    expect(config.dryRun).toBe(true);
    expect(config.verbose).toBe(true);
    expect(config.tradeConfig.minLiquidityUsd).toBe(2000);
    expect(config.tradeConfig.defaultTradeAmountUsd).toBe(200);
    
    // Other values should remain unchanged
    expect(config.rpc.httpUrl).toBe(defaultConfig.rpc.httpUrl);
    expect(config.supportedDexes).toEqual(defaultConfig.supportedDexes);
  });
});