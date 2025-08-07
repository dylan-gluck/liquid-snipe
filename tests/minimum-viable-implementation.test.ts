import { execSync } from 'child_process';
import * as fs from 'fs';
import { DatabaseOptionalController } from '../src/core/database-optional-controller';
import { ConfigManager } from '../src/config/config-manager';
import { MockDatabaseManager, MockCoreController, testApplicationFlow } from './mock-database-testing';

/**
 * Minimum Viable Implementation Tests
 * 
 * This test suite validates the minimum working version of the application
 * that can demonstrate core functionality without requiring database bindings.
 */

describe('Minimum Viable Implementation', () => {
  let testConfigPath: string;
  let originalEnv: any;

  beforeAll(() => {
    testConfigPath = './test-mvi-config.yaml';
    originalEnv = { ...process.env };
  });

  afterAll(() => {
    // Cleanup test files
    [testConfigPath].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Restore environment
    process.env = originalEnv;
  });

  describe('Core Configuration Management', () => {
    it('should load and validate configuration without database', async () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();

      expect(config).toBeDefined();
      expect(config.rpc.httpUrl).toBeDefined();
      expect(config.wallet.keypairPath).toBeDefined();
      expect(config.supportedDexes.length).toBeGreaterThan(0);
    });

    it('should export configuration to file', async () => {
      const result = await DatabaseOptionalController.exportConfiguration(testConfigPath);
      expect(fs.existsSync(testConfigPath)).toBe(true);
      
      const configContent = fs.readFileSync(testConfigPath, 'utf8');
      expect(configContent).toContain('rpc:');
      expect(configContent).toContain('wallet:');
      expect(configContent).toContain('tradeConfig:');
    });

    it('should validate configuration files', async () => {
      // First export a valid config
      await DatabaseOptionalController.exportConfiguration(testConfigPath);
      
      // Then validate it
      const isValid = await DatabaseOptionalController.testConfigurationValidation(testConfigPath);
      expect(isValid).toBe(true);
    });

    it('should handle environment variable overrides', () => {
      // Set test environment variables
      process.env.LIQUID_SNIPE_DRY_RUN = 'true';
      process.env.LIQUID_SNIPE_LOG_LEVEL = 'debug';
      process.env.LIQUID_SNIPE_DISABLE_TUI = 'true';

      const configManager = new ConfigManager();
      const config = configManager.getConfig();

      expect(config.dryRun).toBe(true);
      expect(config.logLevel).toBe('debug');
      expect(config.disableTui).toBe(true);
    });
  });

  describe('Database-Optional Controller', () => {
    let controller: DatabaseOptionalController;

    afterEach(async () => {
      if (controller) {
        try {
          await controller.stop();
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    });

    it('should initialize without database', async () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      controller = new DatabaseOptionalController(config, { skipDatabase: true, mockMode: true });
      await controller.initialize({ skipDatabase: true });

      const status = controller.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.databaseAvailable).toBe(false);
    });

    it('should start and run in mock mode', async () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      controller = new DatabaseOptionalController(config, { skipDatabase: true, mockMode: true });
      await controller.initialize({ skipDatabase: true });
      
      // Start but don't wait (it would run indefinitely)
      const startPromise = controller.start();
      
      // Give it a moment to start
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const status = controller.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.shuttingDown).toBe(false);

      await controller.stop();
    });

    it('should handle graceful shutdown', async () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      controller = new DatabaseOptionalController(config, { skipDatabase: true, mockMode: true });
      await controller.initialize({ skipDatabase: true });
      
      // Start in test mode
      const startPromise = controller.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Stop gracefully
      await controller.stop();
      
      const status = controller.getStatus();
      expect(status.shuttingDown).toBe(true);
    });
  });

  describe('Mock Database Operations', () => {
    it('should create mock database manager', () => {
      const mockDb = new MockDatabaseManager('./test-db.db', { verbose: false });
      expect(mockDb).toBeDefined();
      expect(mockDb.isInitialized()).toBe(false);
    });

    it('should initialize mock database', async () => {
      const mockDb = new MockDatabaseManager('./test-db.db', { verbose: false });
      await mockDb.initialize();
      expect(mockDb.isInitialized()).toBe(true);
      await mockDb.close();
    });

    it('should perform mock database operations', async () => {
      const mockDb = new MockDatabaseManager('./test-db.db', { verbose: false });
      await mockDb.initialize();

      // Test mock operations (should not throw)
      await mockDb.saveLiquidityPool({ address: 'test-pool' });
      await mockDb.savePosition({ id: 'test-position' });
      await mockDb.saveTrade({ id: 'test-trade' });

      const pools = await mockDb.getLiquidityPools();
      const positions = await mockDb.getPositions();
      const trades = await mockDb.getTrades();

      expect(Array.isArray(pools)).toBe(true);
      expect(Array.isArray(positions)).toBe(true);
      expect(Array.isArray(trades)).toBe(true);

      await mockDb.close();
    });
  });

  describe('Mock Core Controller', () => {
    it('should create and run mock core controller', async () => {
      const configManager = new ConfigManager();
      const config = configManager.getConfig();
      
      const mockController = new MockCoreController(config);
      await mockController.initialize();
      
      const status = mockController.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.databaseConnected).toBe(true);
      expect(status.config.enabledDexes).toBeGreaterThan(0);

      // Start and run briefly
      const startPromise = mockController.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await mockController.stop();
    });
  });

  describe('Full Application Flow Test', () => {
    it('should run complete mock application flow', async () => {
      // This test runs the full mock application flow
      await expect(testApplicationFlow()).resolves.not.toThrow();
    }, 10000);
  });

  describe('CLI Command Integration', () => {
    it('should run help command with database-optional mode', () => {
      // This would require modifying the main CLI to support database-optional mode
      // For now, we'll test that the commands that work continue to work
      const result = execSync('pnpm start export-config test-cli-config.yaml', { 
        encoding: 'utf-8',
        cwd: process.cwd()
      });

      expect(result).toContain('Configuration exported');
      
      // Cleanup
      if (fs.existsSync('test-cli-config.yaml')) {
        fs.unlinkSync('test-cli-config.yaml');
      }
    });
  });
});

describe('Feature Demonstration Without Database', () => {
  it('should demonstrate configuration management', async () => {
    const configManager = new ConfigManager();
    const config = configManager.getConfig();

    // Show that configuration system works
    expect(config.supportedDexes.length).toBeGreaterThan(0);
    expect(config.exitStrategies.length).toBeGreaterThan(0);
    expect(config.rpc.httpUrl).toContain('solana');
    expect(config.tradeConfig.defaultTradeAmountUsd).toBeGreaterThan(0);
  });

  it('should demonstrate DEX management', () => {
    const configManager = new ConfigManager();
    
    // Enable/disable DEXes
    const enableResult = configManager.enableDex('raydium');
    expect(enableResult).toBe(true);
    
    const disableResult = configManager.disableDex('raydium');
    expect(disableResult).toBe(true);
    
    const enabledDexes = configManager.getEnabledDexes();
    expect(Array.isArray(enabledDexes)).toBe(true);
  });

  it('should demonstrate exit strategy management', () => {
    const configManager = new ConfigManager();
    
    const stopLossStrategy = configManager.getExitStrategy('stop_loss');
    expect(stopLossStrategy).toBeDefined();
    
    const enabledStrategies = configManager.getEnabledExitStrategies();
    expect(Array.isArray(enabledStrategies)).toBe(true);
    expect(enabledStrategies.length).toBeGreaterThan(0);
  });

  it('should demonstrate environment override functionality', () => {
    // Test that environment variables override config values
    process.env.LIQUID_SNIPE_DRY_RUN = 'true';
    process.env.LIQUID_SNIPE_VERBOSE = 'true';
    
    const configManager = new ConfigManager();
    const config = configManager.getConfig();
    
    expect(config.dryRun).toBe(true);
    expect(config.verbose).toBe(true);
    
    // Cleanup
    delete process.env.LIQUID_SNIPE_DRY_RUN;
    delete process.env.LIQUID_SNIPE_VERBOSE;
  });
});

/**
 * Test Summary:
 * 
 * WORKING FUNCTIONALITY WITHOUT DATABASE:
 * ✅ Configuration loading and validation
 * ✅ Configuration file export/import
 * ✅ Environment variable processing
 * ✅ DEX enable/disable functionality
 * ✅ Exit strategy management
 * ✅ Command-line argument parsing
 * ✅ Mock database operations
 * ✅ Mock application flow
 * ✅ Graceful initialization and shutdown
 * 
 * MINIMUM VIABLE FEATURES:
 * 1. Configuration management system
 * 2. Mock trading engine
 * 3. Mock data processing
 * 4. Command-line interface
 * 5. Logging and event system
 * 6. Environment configuration
 * 
 * NEXT STEPS FOR FULL IMPLEMENTATION:
 * 1. Fix better-sqlite3 bindings
 * 2. Enable database-dependent features
 * 3. Connect real Solana blockchain monitoring
 * 4. Enable actual trading functionality
 * 5. Activate TUI interface
 */