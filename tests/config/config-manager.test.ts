import fs from 'fs';
import path from 'path';
import { ConfigManager, ConfigValidationError } from '../../src/config';
import defaultConfig from '../../src/config/default';

// Helper to create a temporary config file
function createTempConfigFile(content: string, extension: string): string {
  const tempDir = path.join(__dirname, '.tmp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFile = path.join(tempDir, `test-config-${Date.now()}${extension}`);
  fs.writeFileSync(tempFile, content);
  return tempFile;
}

// Clean up test files
afterAll(() => {
  const tempDir = path.join(__dirname, '.tmp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('ConfigManager', () => {
  // Test loading default configuration
  describe('Default Configuration', () => {
    it('should load default configuration when no config file is provided', () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      expect(config).toEqual(defaultConfig);
      expect(config.rpc.httpUrl).toBe('https://api.mainnet-beta.solana.com');
      expect(config.supportedDexes.length).toBeGreaterThan(0);
      expect(config.wallet.riskPercent).toBe(5);
    });
  });

  // Test loading from file
  describe('File Configuration', () => {
    it('should load JSON configuration file', () => {
      const configContent = JSON.stringify({
        rpc: {
          httpUrl: 'https://custom-rpc.solana.com',
        },
        wallet: {
          riskPercent: 10,
        },
      });
      
      const configPath = createTempConfigFile(configContent, '.json');
      const configManager = new ConfigManager(configPath);
      const config = configManager.getConfig();
      
      expect(config.rpc.httpUrl).toBe('https://custom-rpc.solana.com');
      expect(config.wallet.riskPercent).toBe(10);
      // Other values should remain unchanged
      expect(config.rpc.wsUrl).toBe(defaultConfig.rpc.wsUrl);
    });
    
    it('should load YAML configuration file', () => {
      const configContent = `
rpc:
  httpUrl: https://custom-yaml-rpc.solana.com
wallet:
  riskPercent: 15
      `;
      
      const configPath = createTempConfigFile(configContent, '.yaml');
      const configManager = new ConfigManager(configPath);
      const config = configManager.getConfig();
      
      expect(config.rpc.httpUrl).toBe('https://custom-yaml-rpc.solana.com');
      expect(config.wallet.riskPercent).toBe(15);
      // Other values should remain unchanged
      expect(config.rpc.wsUrl).toBe(defaultConfig.rpc.wsUrl);
    });
    
    it('should handle non-existent configuration file gracefully', () => {
      const nonExistentPath = '/path/to/nonexistent/config.json';
      
      // Should not throw an error, just log a warning and use defaults
      expect(() => new ConfigManager(nonExistentPath)).not.toThrow();
      
      const configManager = new ConfigManager(nonExistentPath);
      const config = configManager.getConfig();
      
      // Should use default values
      expect(config).toEqual(defaultConfig);
    });
    
    it('should throw an error for invalid JSON in configuration file', () => {
      const invalidJson = `{ 
        "rpc": { 
          "httpUrl": "https://invalid-json.solana.com",
        } 
      }`;
      
      const configPath = createTempConfigFile(invalidJson, '.json');
      
      expect(() => new ConfigManager(configPath)).toThrow();
    });
    
    it('should throw an error for unsupported file extension', () => {
      const configPath = createTempConfigFile('some content', '.txt');
      
      expect(() => new ConfigManager(configPath)).toThrow(/Unsupported configuration file format/);
    });
  });

  // Test overriding configurations
  describe('Configuration Overrides', () => {
    it('should override configuration values', () => {
      const configManager = new ConfigManager();
      
      const overrides = {
        dryRun: true,
        verbose: true,
        tradeConfig: {
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
    
    it('should recursively merge nested objects', () => {
      const configManager = new ConfigManager();
      
      // Get current config to ensure we have all required fields
      const currentConfig = configManager.getConfig();
      
      const overrides = {
        rpc: {
          ...currentConfig.rpc,
          httpUrl: 'https://override-rpc.solana.com',
          // Don't override wsUrl
        },
        wallet: {
          ...currentConfig.wallet,
          // Override only risk percent
          riskPercent: 8,
        },
      };
      
      configManager.override(overrides);
      const config = configManager.getConfig();
      
      expect(config.rpc.httpUrl).toBe('https://override-rpc.solana.com');
      expect(config.rpc.wsUrl).toBe(defaultConfig.rpc.wsUrl); // Unchanged
      expect(config.wallet.riskPercent).toBe(8);
      expect(config.wallet.keypairPath).toBe(defaultConfig.wallet.keypairPath); // Unchanged
    });
    
    it('should replace arrays instead of merging them', () => {
      const configManager = new ConfigManager();
      
      const overrides = {
        supportedDexes: [
          {
            name: 'CustomDEX',
            programId: 'customdex123456789',
            instructions: {
              newPoolCreation: 'createPool',
            },
            enabled: true,
          },
        ],
      };
      
      configManager.override(overrides);
      const config = configManager.getConfig();
      
      // Array should be completely replaced
      expect(config.supportedDexes.length).toBe(1);
      expect(config.supportedDexes[0].name).toBe('CustomDEX');
    });
  });

  // Test configuration validation
  describe('Configuration Validation', () => {
    it('should validate required fields', () => {
      const configManager = new ConfigManager();
      
      // Get a copy of the current config so we can make a valid change
      const currentConfig = configManager.getConfig();
      
      // Make an invalid change - empty URL
      const invalidConfig = {
        rpc: {
          ...currentConfig.rpc,
          httpUrl: '', // Empty URL is invalid
        },
      };
      
      expect(() => configManager.override(invalidConfig)).toThrow(ConfigValidationError);
    });
    
    it('should validate numeric ranges', () => {
      const configManager = new ConfigManager();
      
      // Get a copy of the current config so we can make a valid change
      const currentConfig = configManager.getConfig();
      
      // Set invalid numeric values
      const invalidConfig = {
        wallet: {
          ...currentConfig.wallet,
          riskPercent: 101, // Over 100% is invalid
        },
      };
      
      expect(() => configManager.override(invalidConfig)).toThrow(ConfigValidationError);
    });
    
    it('should validate that at least one DEX is enabled', () => {
      const configManager = new ConfigManager();
      
      // Disable all DEXes
      const disableAllDexes = {
        supportedDexes: defaultConfig.supportedDexes.map(dex => ({
          ...dex,
          enabled: false,
        })),
      };
      
      expect(() => configManager.override(disableAllDexes)).toThrow(ConfigValidationError);
    });
    
    it('should validate that at least one exit strategy is enabled', () => {
      const configManager = new ConfigManager();
      
      // Disable all exit strategies
      const disableAllStrategies = {
        exitStrategies: defaultConfig.exitStrategies.map(strategy => ({
          ...strategy,
          enabled: false,
        })),
      };
      
      expect(() => configManager.override(disableAllStrategies)).toThrow(ConfigValidationError);
    });
  });
  
  // Test DEX management functions
  describe('DEX Management', () => {
    it('should enable and disable DEXes by name', () => {
      const configManager = new ConfigManager();
      
      // Disable all DEXes first except the first one
      const dexConfigs = defaultConfig.supportedDexes.map((dex, index) => ({
        ...dex,
        enabled: index === 0,
      }));
      
      configManager.override({ supportedDexes: dexConfigs });
      
      // Get the second DEX name
      const secondDexName = dexConfigs[1].name;
      
      // Enable the second DEX
      const enableResult = configManager.enableDex(secondDexName);
      expect(enableResult).toBe(true);
      
      // Check that it's enabled
      const dex = configManager.getDexConfig(secondDexName);
      expect(dex?.enabled).toBe(true);
      
      // Disable it again
      const disableResult = configManager.disableDex(secondDexName);
      expect(disableResult).toBe(true);
      
      // Check that it's disabled
      const dexAfterDisable = configManager.getDexConfig(secondDexName);
      expect(dexAfterDisable?.enabled).toBe(false);
    });
    
    it('should handle unknown DEX names', () => {
      const configManager = new ConfigManager();
      
      // Try to enable a non-existent DEX
      const enableResult = configManager.enableDex('NonExistentDEX');
      expect(enableResult).toBe(false);
      
      // Try to disable it
      const disableResult = configManager.disableDex('NonExistentDEX');
      expect(disableResult).toBe(false);
    });
    
    it('should return only enabled DEXes', () => {
      const configManager = new ConfigManager();
      
      // Disable the second DEX
      const dexConfigs = defaultConfig.supportedDexes.map((dex, index) => ({
        ...dex,
        enabled: index !== 1,
      }));
      
      configManager.override({ supportedDexes: dexConfigs });
      
      // Get enabled DEXes
      const enabledDexes = configManager.getEnabledDexes();
      
      // Verify length
      expect(enabledDexes.length).toBe(dexConfigs.filter(d => d.enabled).length);
      
      // Verify all returned DEXes are enabled
      expect(enabledDexes.every(dex => dex.enabled)).toBe(true);
    });
  });
  
  // Test exit strategy management
  describe('Exit Strategy Management', () => {
    it('should find exit strategies by name or type', () => {
      const configManager = new ConfigManager();
      
      // Get a strategy by type
      const profitStrategy = configManager.getExitStrategy('profit');
      expect(profitStrategy).toBeDefined();
      expect(profitStrategy?.type).toBe('profit');
      
      // Get a strategy by name if it's defined
      const profitStrategyByName = configManager.getExitStrategy(
        defaultConfig.exitStrategies.find(s => s.type === 'profit')?.name || ''
      );
      expect(profitStrategyByName).toBeDefined();
      
      // Returns undefined for unknown names/types
      const unknownStrategy = configManager.getExitStrategy('unknown');
      expect(unknownStrategy).toBeUndefined();
    });
    
    it('should return only enabled exit strategies', () => {
      const configManager = new ConfigManager();
      
      // Disable some strategies
      const strategyConfigs = defaultConfig.exitStrategies.map((strategy, index) => ({
        ...strategy,
        enabled: index % 2 === 0, // Enable every other strategy
      }));
      
      configManager.override({ exitStrategies: strategyConfigs });
      
      // Get enabled strategies
      const enabledStrategies = configManager.getEnabledExitStrategies();
      
      // Verify length
      expect(enabledStrategies.length).toBe(strategyConfigs.filter(s => s.enabled).length);
      
      // Verify all returned strategies are enabled
      expect(enabledStrategies.every(strategy => strategy.enabled)).toBe(true);
    });
  });
  
  // Test configuration save functionality
  describe('Configuration Save', () => {
    it('should save configuration to JSON file', () => {
      const configManager = new ConfigManager();
      const currentConfig = configManager.getConfig();
      
      // Override some values
      configManager.override({
        rpc: {
          ...currentConfig.rpc,
          httpUrl: 'https://save-test-rpc.solana.com',
        },
        wallet: {
          ...currentConfig.wallet,
          riskPercent: 12,
        },
      });
      
      // Save to file
      const savePath = path.join(__dirname, '.tmp', 'saved-config.json');
      configManager.saveToFile(savePath);
      
      // Check that file exists
      expect(fs.existsSync(savePath)).toBe(true);
      
      // Read and parse the file
      const savedContent = fs.readFileSync(savePath, 'utf8');
      const savedConfig = JSON.parse(savedContent);
      
      // Verify saved values
      expect(savedConfig.rpc.httpUrl).toBe('https://save-test-rpc.solana.com');
      expect(savedConfig.wallet.riskPercent).toBe(12);
    });
    
    it('should save configuration to YAML file', () => {
      const configManager = new ConfigManager();
      const currentConfig = configManager.getConfig();
      
      // Override some values
      configManager.override({
        rpc: {
          ...currentConfig.rpc,
          httpUrl: 'https://save-test-yaml-rpc.solana.com',
        },
        wallet: {
          ...currentConfig.wallet,
          riskPercent: 15,
        },
      });
      
      // Save to file
      const savePath = path.join(__dirname, '.tmp', 'saved-config.yaml');
      configManager.saveToFile(savePath);
      
      // Check that file exists
      expect(fs.existsSync(savePath)).toBe(true);
      
      // The YAML content is harder to test directly, but we can load it with a new ConfigManager
      const loadedManager = new ConfigManager(savePath);
      const loadedConfig = loadedManager.getConfig();
      
      // Verify loaded values
      expect(loadedConfig.rpc.httpUrl).toBe('https://save-test-yaml-rpc.solana.com');
      expect(loadedConfig.wallet.riskPercent).toBe(15);
    });
    
    it('should throw error for unsupported file extensions', () => {
      const configManager = new ConfigManager();
      const savePath = path.join(__dirname, '.tmp', 'invalid-config.txt');
      
      expect(() => configManager.saveToFile(savePath)).toThrow(/Unsupported file extension/);
    });
  });
});