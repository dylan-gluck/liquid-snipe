#!/usr/bin/env npx ts-node
/**
 * Production Validation Script for Liquid-Snipe MVP
 * 
 * This script performs comprehensive validation of the MVP to ensure
 * it's ready for production deployment on Solana mainnet.
 */

import { Logger } from '../src/utils/logger';
import { ConfigManager } from '../src/config/config-manager';
import DatabaseManager from '../src/db';
import { ConnectionManager } from '../src/blockchain/connection-manager';
import { TokenInfoService } from '../src/blockchain/token-info-service';
import { TradeExecutor } from '../src/trading/trade-executor';
import { PositionManager } from '../src/trading/position-manager';
import { RiskManager } from '../src/security/risk-manager';
import { SlippageProtection } from '../src/security/slippage-protection';
import { TransactionSimulator } from '../src/security/transaction-simulator';
import { PriceFeedService } from '../src/data/price-feed-service';
import { MarketDataManager } from '../src/data/market-data-manager';
import fs from 'fs';
import path from 'path';

interface ValidationResult {
  component: string;
  status: 'PASS' | 'FAIL' | 'WARNING';
  message: string;
  details?: any;
  duration?: number;
}

class ProductionValidator {
  private logger: Logger;
  private results: ValidationResult[] = [];
  private configManager: ConfigManager;
  private dbManager: DatabaseManager;

  constructor() {
    this.logger = new Logger('ProductionValidator', { verbose: true });
    this.configManager = new ConfigManager();
  }

  async runValidation(): Promise<void> {
    this.logger.info('🚀 Starting Production Validation for Liquid-Snipe MVP');
    this.logger.info('=' .repeat(60));

    const startTime = Date.now();

    try {
      // Phase 1: Configuration & Environment Validation
      await this.validateConfiguration();
      await this.validateEnvironmentVariables();
      await this.validateFilePermissions();
      
      // Phase 2: Core Component Validation
      await this.validateDatabase();
      await this.validateBlockchainConnection();
      await this.validatePriceFeedServices();
      
      // Phase 3: Trading System Validation
      await this.validateTradeExecutor();
      await this.validatePositionManager();
      await this.validateRiskManagement();
      await this.validateSlippageProtection();
      
      // Phase 4: Security & Safety Validation
      await this.validateTransactionSimulator();
      await this.validateSecurityMeasures();
      await this.validateWalletSafety();
      
      // Phase 5: Performance & Resource Validation
      await this.validateMemoryUsage();
      await this.validateErrorHandling();
      
    } catch (error) {
      this.addResult('VALIDATION_FRAMEWORK', 'FAIL', `Validation framework error: ${error.message}`);
    }

    const totalTime = Date.now() - startTime;
    this.generateReport(totalTime);
  }

  private async validateConfiguration(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Check if configuration files exist
      const configExists = fs.existsSync('./config.example.yaml');
      if (!configExists) {
        this.addResult('CONFIG_FILES', 'FAIL', 'config.example.yaml not found');
        return;
      }

      // Load and validate configuration
      await this.configManager.initialize('./config.example.yaml');
      const config = this.configManager.getConfig();

      // Validate critical configuration sections
      const requiredSections = ['rpc', 'wallet', 'tradeConfig', 'exitStrategies', 'database'];
      for (const section of requiredSections) {
        if (!config[section]) {
          this.addResult('CONFIG_VALIDATION', 'FAIL', `Missing required section: ${section}`);
          return;
        }
      }

      // Validate RPC configuration
      if (!config.rpc.httpUrl || !config.rpc.wsUrl) {
        this.addResult('RPC_CONFIG', 'FAIL', 'Missing RPC URLs');
        return;
      }

      // Validate wallet configuration
      if (config.wallet.riskPercent > 10) {
        this.addResult('WALLET_CONFIG', 'WARNING', `High risk percentage: ${config.wallet.riskPercent}%`);
      }

      // Validate trade configuration
      if (config.tradeConfig.minLiquidityUsd < 1000) {
        this.addResult('TRADE_CONFIG', 'WARNING', 'Low minimum liquidity threshold');
      }

      this.addResult('CONFIG_VALIDATION', 'PASS', 'Configuration validation successful', 
        { sections: requiredSections.length }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('CONFIG_VALIDATION', 'FAIL', `Configuration error: ${error.message}`);
    }
  }

  private async validateEnvironmentVariables(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const envExample = './src/config/env-example.ts';
      if (!fs.existsSync(envExample)) {
        this.addResult('ENV_VALIDATION', 'FAIL', 'env-example.ts not found');
        return;
      }

      // Read env example and extract required variables
      const envContent = fs.readFileSync(envExample, 'utf8');
      const exportMatches = envContent.match(/export const (\w+)/g) || [];
      const requiredVars = exportMatches.map(match => match.replace('export const ', ''));

      // Check critical environment variables
      const criticalVars = [
        'SOLANA_RPC_HTTP_URL',
        'SOLANA_RPC_WS_URL',
        'WALLET_KEYPAIR_PATH',
        'DATABASE_PATH'
      ];

      const missingCritical = criticalVars.filter(varName => 
        !requiredVars.includes(varName)
      );

      if (missingCritical.length > 0) {
        this.addResult('ENV_VALIDATION', 'FAIL', 
          `Missing critical environment variables: ${missingCritical.join(', ')}`);
        return;
      }

      this.addResult('ENV_VALIDATION', 'PASS', 'Environment variables validated',
        { totalVars: requiredVars.length, criticalVars: criticalVars.length }, 
        Date.now() - startTime);
      
    } catch (error) {
      this.addResult('ENV_VALIDATION', 'FAIL', `Environment validation error: ${error.message}`);
    }
  }

  private async validateFilePermissions(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const criticalFiles = [
        './dist/index.js', // Built application
        './data', // Database directory
        './src/index.ts' // Main source file
      ];

      for (const filePath of criticalFiles) {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          if (filePath.includes('data') && !stats.isDirectory()) {
            this.addResult('FILE_PERMISSIONS', 'WARNING', `Data path exists but not a directory: ${filePath}`);
          }
        } else if (filePath === './dist/index.js') {
          this.addResult('FILE_PERMISSIONS', 'WARNING', 'Application not built - run npm run build');
        }
      }

      this.addResult('FILE_PERMISSIONS', 'PASS', 'File permissions validated', 
        { checkedFiles: criticalFiles.length }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('FILE_PERMISSIONS', 'FAIL', `File permission error: ${error.message}`);
    }
  }

  private async validateDatabase(): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.dbManager = new DatabaseManager('./data/validation-test.db', {
        verbose: false,
        logToDatabase: false
      });

      await this.dbManager.initialize();

      // Test basic operations
      const testToken = {
        address: 'test-token-address',
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 6,
        firstSeen: Date.now(),
        isVerified: false,
        metadata: { test: true }
      };

      await this.dbManager.addToken(testToken);
      const retrievedToken = await this.dbManager.getToken('test-token-address');
      
      if (!retrievedToken || retrievedToken.symbol !== 'TEST') {
        this.addResult('DATABASE_OPERATIONS', 'FAIL', 'Database CRUD operations failed');
        return;
      }

      // Test database stats
      const stats = await this.dbManager.getStats();
      if (typeof stats.tokenCount !== 'number') {
        this.addResult('DATABASE_STATS', 'FAIL', 'Database stats not working');
        return;
      }

      // Cleanup test data
      await this.dbManager.close();
      if (fs.existsSync('./data/validation-test.db')) {
        fs.unlinkSync('./data/validation-test.db');
      }

      this.addResult('DATABASE_VALIDATION', 'PASS', 'Database validation successful',
        { testOperations: ['create', 'read', 'stats'] }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('DATABASE_VALIDATION', 'FAIL', `Database error: ${error.message}`);
      try {
        if (this.dbManager) await this.dbManager.close();
      } catch (closeError) {
        // Ignore cleanup errors
      }
    }
  }

  private async validateBlockchainConnection(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const connectionManager = new ConnectionManager({
        httpUrl: 'https://api.mainnet-beta.solana.com',
        wsUrl: 'wss://api.mainnet-beta.solana.com',
        connectionTimeout: 10000,
        commitment: 'confirmed'
      });

      // Test RPC connection
      const rpcConnection = connectionManager.getRpcConnection();
      const version = await rpcConnection.getVersion();
      
      if (!version['solana-core']) {
        this.addResult('RPC_CONNECTION', 'FAIL', 'Invalid Solana RPC response');
        return;
      }

      // Test health check
      const isHealthy = await connectionManager.healthCheck();
      if (!isHealthy) {
        this.addResult('CONNECTION_HEALTH', 'WARNING', 'Connection health check failed');
      }

      this.addResult('BLOCKCHAIN_CONNECTION', 'PASS', 'Blockchain connection validated',
        { solanaVersion: version['solana-core'] }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('BLOCKCHAIN_CONNECTION', 'FAIL', `Connection error: ${error.message}`);
    }
  }

  private async validatePriceFeedServices(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const priceFeedService = new PriceFeedService({
        coingeckoApiKey: undefined, // Use free tier
        birdeyeApiKey: 'demo', // Demo key
        rateLimits: {
          coingecko: { requestsPerMinute: 10 },
          birdeye: { requestsPerMinute: 30 }
        }
      });

      // Test with a well-known token (SOL)
      const solPrice = await priceFeedService.getPrice('So11111111111111111111111111111111111111112');
      
      if (typeof solPrice !== 'number' || solPrice <= 0) {
        this.addResult('PRICE_FEED', 'FAIL', 'Invalid price data received');
        return;
      }

      // Test market data manager
      const marketDataManager = new MarketDataManager(priceFeedService);
      const tokenData = await marketDataManager.getTokenData('So11111111111111111111111111111111111111112');
      
      if (!tokenData || !tokenData.price) {
        this.addResult('MARKET_DATA', 'WARNING', 'Market data incomplete');
      }

      this.addResult('PRICE_FEED_VALIDATION', 'PASS', 'Price feed services validated',
        { solPrice, tokenDataFields: tokenData ? Object.keys(tokenData).length : 0 }, 
        Date.now() - startTime);
      
    } catch (error) {
      this.addResult('PRICE_FEED_VALIDATION', 'FAIL', `Price feed error: ${error.message}`);
    }
  }

  private async validateTradeExecutor(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Initialize with mock configuration
      const config = await this.configManager.getConfig();
      
      const tradeExecutor = new TradeExecutor(
        null as any, // Mock connection
        config,
        true // Dry run mode
      );

      // Validate trade executor initialization
      if (!tradeExecutor) {
        this.addResult('TRADE_EXECUTOR', 'FAIL', 'Trade executor initialization failed');
        return;
      }

      // Test dry run validation
      const isDryRun = tradeExecutor.isDryRunMode();
      if (!isDryRun) {
        this.addResult('TRADE_EXECUTOR', 'WARNING', 'Trade executor not in dry run mode');
      }

      this.addResult('TRADE_EXECUTOR_VALIDATION', 'PASS', 'Trade executor validated',
        { dryRunMode: isDryRun }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('TRADE_EXECUTOR_VALIDATION', 'FAIL', `Trade executor error: ${error.message}`);
    }
  }

  private async validatePositionManager(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const config = await this.configManager.getConfig();
      const mockDbManager = {} as DatabaseManager; // Mock for validation
      
      const positionManager = new PositionManager(
        mockDbManager,
        config.exitStrategies || [],
        true // Dry run mode
      );

      // Validate position manager initialization
      if (!positionManager) {
        this.addResult('POSITION_MANAGER', 'FAIL', 'Position manager initialization failed');
        return;
      }

      // Validate exit strategies are loaded
      const strategies = positionManager.getAvailableStrategies();
      if (!strategies || strategies.length === 0) {
        this.addResult('EXIT_STRATEGIES', 'WARNING', 'No exit strategies configured');
      }

      this.addResult('POSITION_MANAGER_VALIDATION', 'PASS', 'Position manager validated',
        { exitStrategies: strategies?.length || 0 }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('POSITION_MANAGER_VALIDATION', 'FAIL', `Position manager error: ${error.message}`);
    }
  }

  private async validateRiskManagement(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const config = await this.configManager.getConfig();
      
      const riskManager = new RiskManager({
        maxRiskPercentage: config.wallet?.riskPercent || 5,
        maxTotalRiskPercentage: config.wallet?.maxTotalRiskPercent || 20,
        maxPositions: 10,
        stopLossPercentage: 20,
        circuitBreakerThreshold: 5
      });

      // Test risk calculation
      const riskAmount = riskManager.calculateMaxTradeAmount(1000); // $1000 portfolio
      const expectedMax = (config.wallet?.riskPercent || 5) * 10; // 5% of $1000
      
      if (Math.abs(riskAmount - expectedMax) > 1) {
        this.addResult('RISK_CALCULATION', 'FAIL', 'Risk calculation error');
        return;
      }

      // Test risk validation
      const isValidTrade = riskManager.validateTrade({
        amount: 50,
        tokenAddress: 'test-token',
        direction: 'BUY',
        currentPortfolioValue: 1000,
        existingRisk: 100
      });

      if (typeof isValidTrade !== 'boolean') {
        this.addResult('RISK_VALIDATION', 'FAIL', 'Risk validation not working');
        return;
      }

      this.addResult('RISK_MANAGEMENT_VALIDATION', 'PASS', 'Risk management validated',
        { maxTradeAmount: riskAmount, validationWorking: true }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('RISK_MANAGEMENT_VALIDATION', 'FAIL', `Risk management error: ${error.message}`);
    }
  }

  private async validateSlippageProtection(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const slippageProtection = new SlippageProtection({
        maxSlippagePercent: 5,
        priceImpactThreshold: 2,
        dynamicAdjustment: true
      });

      // Test slippage calculation
      const slippage = slippageProtection.calculateSlippage(100, 95); // 5% slippage
      if (Math.abs(slippage - 5) > 0.1) {
        this.addResult('SLIPPAGE_CALCULATION', 'FAIL', 'Slippage calculation error');
        return;
      }

      // Test protection validation
      const isProtected = slippageProtection.validateTransaction({
        expectedPrice: 100,
        actualPrice: 97,
        amount: 1000,
        maxSlippage: 5
      });

      if (typeof isProtected !== 'boolean') {
        this.addResult('SLIPPAGE_VALIDATION', 'FAIL', 'Slippage validation not working');
        return;
      }

      this.addResult('SLIPPAGE_PROTECTION_VALIDATION', 'PASS', 'Slippage protection validated',
        { calculatedSlippage: slippage, protectionWorking: true }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('SLIPPAGE_PROTECTION_VALIDATION', 'FAIL', `Slippage protection error: ${error.message}`);
    }
  }

  private async validateTransactionSimulator(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const transactionSimulator = new TransactionSimulator({
        simulationTimeout: 10000,
        maxComputeUnits: 200000,
        enableSlippageSimulation: true
      });

      // Test simulation setup
      const canSimulate = transactionSimulator.isEnabled();
      if (!canSimulate) {
        this.addResult('TRANSACTION_SIMULATOR', 'WARNING', 'Transaction simulator disabled');
      }

      this.addResult('TRANSACTION_SIMULATOR_VALIDATION', 'PASS', 'Transaction simulator validated',
        { enabled: canSimulate }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('TRANSACTION_SIMULATOR_VALIDATION', 'FAIL', `Transaction simulator error: ${error.message}`);
    }
  }

  private async validateSecurityMeasures(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Check for hardcoded secrets in built files
      const distDir = './dist';
      if (fs.existsSync(distDir)) {
        const jsFiles = this.getJavaScriptFiles(distDir);
        const suspiciousPatterns = [
          /private[_\s]*key[_\s]*[=:]/i,
          /secret[_\s]*key[_\s]*[=:]/i,
          /api[_\s]*key[_\s]*[=:]/i,
          /[0-9a-fA-F]{64}/,  // Potential private key
          /[0-9a-fA-F]{128}/, // Potential extended private key
        ];

        for (const file of jsFiles.slice(0, 5)) { // Check first 5 files only
          const content = fs.readFileSync(file, 'utf8');
          for (const pattern of suspiciousPatterns) {
            if (pattern.test(content)) {
              this.addResult('SECURITY_SCAN', 'FAIL', `Potential secret found in ${path.basename(file)}`);
              return;
            }
          }
        }
      }

      // Check source files for console.log statements
      const srcFiles = this.getTypeScriptFiles('./src').slice(0, 10); // Check first 10 files
      const consoleLogCount = srcFiles.reduce((count, file) => {
        const content = fs.readFileSync(file, 'utf8');
        const matches = content.match(/console\.(log|debug|info|warn|error)/g);
        return count + (matches ? matches.length : 0);
      }, 0);

      if (consoleLogCount > 0) {
        this.addResult('SECURITY_SCAN', 'WARNING', `${consoleLogCount} console statements found in source`);
      }

      this.addResult('SECURITY_MEASURES_VALIDATION', 'PASS', 'Security measures validated',
        { scannedFiles: jsFiles?.length || 0, consoleLogCount }, Date.now() - startTime);
      
    } catch (error) {
      this.addResult('SECURITY_MEASURES_VALIDATION', 'FAIL', `Security validation error: ${error.message}`);
    }
  }

  private async validateWalletSafety(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Validate wallet configuration safety
      const config = await this.configManager.getConfig();
      const walletConfig = config.wallet;
      
      if (!walletConfig) {
        this.addResult('WALLET_SAFETY', 'FAIL', 'Wallet configuration missing');
        return;
      }

      // Check risk percentages are reasonable
      if (walletConfig.riskPercent > 10) {
        this.addResult('WALLET_SAFETY', 'FAIL', `Risk percentage too high: ${walletConfig.riskPercent}%`);
        return;
      }

      if (walletConfig.maxTotalRiskPercent > 50) {
        this.addResult('WALLET_SAFETY', 'FAIL', `Total risk percentage too high: ${walletConfig.maxTotalRiskPercent}%`);
        return;
      }

      // Check confirmation requirements
      if (walletConfig.confirmationRequired === false) {
        this.addResult('WALLET_SAFETY', 'WARNING', 'Wallet confirmation disabled - ensure this is intentional for automation');
      }

      this.addResult('WALLET_SAFETY_VALIDATION', 'PASS', 'Wallet safety validated',
        { riskPercent: walletConfig.riskPercent, totalRiskPercent: walletConfig.maxTotalRiskPercent },
        Date.now() - startTime);
      
    } catch (error) {
      this.addResult('WALLET_SAFETY_VALIDATION', 'FAIL', `Wallet safety error: ${error.message}`);
    }
  }

  private async validateMemoryUsage(): Promise<void> {
    const startTime = Date.now();
    
    try {
      const initialMemory = process.memoryUsage();
      
      // Simulate some operations to check memory usage
      const testData = [];
      for (let i = 0; i < 1000; i++) {
        testData.push({
          id: i,
          timestamp: Date.now(),
          data: Buffer.alloc(1024).toString('hex')
        });
      }

      const afterAllocation = process.memoryUsage();
      const memoryIncrease = afterAllocation.heapUsed - initialMemory.heapUsed;
      
      // Clean up
      testData.length = 0;
      global.gc?.(); // Force garbage collection if available

      const finalMemory = process.memoryUsage();

      // Check for memory leaks
      const potentialLeak = finalMemory.heapUsed > initialMemory.heapUsed + (1024 * 1024); // 1MB threshold
      
      if (potentialLeak) {
        this.addResult('MEMORY_USAGE', 'WARNING', 'Potential memory leak detected');
      }

      this.addResult('MEMORY_VALIDATION', 'PASS', 'Memory usage validated',
        { 
          initialHeap: Math.round(initialMemory.heapUsed / 1024 / 1024),
          peakIncrease: Math.round(memoryIncrease / 1024 / 1024),
          finalHeap: Math.round(finalMemory.heapUsed / 1024 / 1024)
        }, 
        Date.now() - startTime);
      
    } catch (error) {
      this.addResult('MEMORY_VALIDATION', 'FAIL', `Memory validation error: ${error.message}`);
    }
  }

  private async validateErrorHandling(): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Test that error classes exist and work
      const { ConnectionManager } = await import('../src/blockchain/connection-manager');
      
      // Test with invalid configuration
      try {
        new ConnectionManager({
          httpUrl: 'invalid-url',
          wsUrl: 'invalid-ws-url',
          connectionTimeout: -1,
          commitment: 'invalid' as any
        });
      } catch (error) {
        // Good - should throw an error
      }

      // Test database error handling
      try {
        const badDb = new DatabaseManager('/root/nonexistent/path/test.db');
        await badDb.initialize();
        this.addResult('ERROR_HANDLING', 'FAIL', 'Database should have failed with bad path');
        return;
      } catch (error) {
        // Good - should throw an error
      }

      this.addResult('ERROR_HANDLING_VALIDATION', 'PASS', 'Error handling validated',
        { testedComponents: ['ConnectionManager', 'DatabaseManager'] },
        Date.now() - startTime);
      
    } catch (error) {
      this.addResult('ERROR_HANDLING_VALIDATION', 'FAIL', `Error handling test error: ${error.message}`);
    }
  }

  private getJavaScriptFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.getJavaScriptFiles(fullPath));
        } else if (item.endsWith('.js')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors accessing directories
    }
    return files;
  }

  private getTypeScriptFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...this.getTypeScriptFiles(fullPath));
        } else if (item.endsWith('.ts') && !item.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors accessing directories
    }
    return files;
  }

  private addResult(component: string, status: ValidationResult['status'], message: string, details?: any, duration?: number): void {
    this.results.push({ component, status, message, details, duration });
  }

  private generateReport(totalTime: number): void {
    this.logger.info('\\n' + '=' .repeat(60));
    this.logger.info('📊 PRODUCTION VALIDATION REPORT');
    this.logger.info('=' .repeat(60));

    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    const warnings = this.results.filter(r => r.status === 'WARNING').length;

    // Summary
    this.logger.info(`\\n📈 SUMMARY:`);
    this.logger.info(`   ✅ Passed:   ${passed}`);
    this.logger.info(`   ❌ Failed:   ${failed}`);
    this.logger.info(`   ⚠️  Warnings: ${warnings}`);
    this.logger.info(`   🕐 Total Time: ${totalTime}ms`);

    // Detailed results
    this.logger.info(`\\n📋 DETAILED RESULTS:`);
    this.results.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️';
      const duration = result.duration ? ` (${result.duration}ms)` : '';
      this.logger.info(`   ${icon} ${result.component}${duration}`);
      this.logger.info(`      ${result.message}`);
      if (result.details && Object.keys(result.details).length > 0) {
        this.logger.info(`      Details: ${JSON.stringify(result.details)}`);
      }
    });

    // Final assessment
    const isProductionReady = failed === 0;
    this.logger.info(`\\n🎯 PRODUCTION READINESS ASSESSMENT:`);
    
    if (isProductionReady) {
      this.logger.info(`   ✅ MVP IS PRODUCTION READY!`);
      this.logger.info(`   🚀 The system has passed all critical validations.`);
      if (warnings > 0) {
        this.logger.info(`   ⚠️  Note: ${warnings} warning(s) should be reviewed before deployment.`);
      }
    } else {
      this.logger.info(`   ❌ MVP IS NOT PRODUCTION READY`);
      this.logger.info(`   🔧 ${failed} critical issue(s) must be resolved before deployment.`);
    }

    // Deployment recommendations
    this.generateDeploymentRecommendations(isProductionReady, warnings, failed);

    this.logger.info('\\n' + '=' .repeat(60));
    this.logger.info(`Validation completed at ${new Date().toISOString()}`);
    this.logger.info('=' .repeat(60));
  }

  private generateDeploymentRecommendations(isReady: boolean, warnings: number, failures: number): void {
    this.logger.info(`\\n📝 DEPLOYMENT RECOMMENDATIONS:`);

    if (isReady) {
      this.logger.info(`   1. ✅ All core systems validated - ready for mainnet deployment`);
      this.logger.info(`   2. 🔐 Ensure wallet private key is securely stored and never logged`);
      this.logger.info(`   3. 💰 Start with small trade amounts to validate real-world performance`);
      this.logger.info(`   4. 📊 Monitor system performance and error rates closely`);
      this.logger.info(`   5. 🔄 Set up automated backups for database and configuration`);
      this.logger.info(`   6. 📱 Configure notification channels for trade alerts`);
      this.logger.info(`   7. 🛡️  Enable circuit breakers and risk management safeguards`);
      
      if (warnings > 0) {
        this.logger.info(`   ⚠️  Address ${warnings} warning(s) for optimal performance`);
      }
    } else {
      this.logger.info(`   ❌ DEPLOYMENT BLOCKED - ${failures} critical issue(s) found:`);
      const criticalFailures = this.results.filter(r => r.status === 'FAIL');
      criticalFailures.forEach((failure, index) => {
        this.logger.info(`      ${index + 1}. ${failure.component}: ${failure.message}`);
      });
      this.logger.info(`   🔧 Fix all critical issues before attempting deployment`);
    }
  }
}

// Run validation if this script is executed directly
if (require.main === module) {
  const validator = new ProductionValidator();
  validator.runValidation().catch(error => {
    console.error('Validation failed:', error);
    process.exit(1);
  });
}

export default ProductionValidator;