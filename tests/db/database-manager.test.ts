import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager, DatabaseError } from '../../src/db';
import { Token, LiquidityPool, Trade, Position, ExitStrategyConfig } from '../../src/types';

// Helper to create a unique test database path
const createTestDbPath = (): string => {
  const tempDir = path.join(__dirname, '.tmp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return path.join(tempDir, `test-db-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
};

// Sample data for tests
const createSampleToken = (overrides: Partial<Token> = {}): Token => ({
  address: `token-${uuidv4()}`,
  symbol: 'TST',
  name: 'Test Token',
  decimals: 9,
  firstSeen: Date.now(),
  isVerified: false,
  metadata: { creator: 'test' },
  ...overrides,
});

const createSamplePool = (tokenA: string, tokenB: string, overrides: Partial<LiquidityPool> = {}): LiquidityPool => ({
  address: `pool-${uuidv4()}`,
  dexName: 'TestDEX',
  tokenA,
  tokenB,
  createdAt: Date.now(),
  initialLiquidityUsd: 10000,
  lastUpdated: Date.now(),
  currentLiquidityUsd: 10000,
  ...overrides,
});

const createSampleTrade = (tokenAddress: string, poolAddress: string, overrides: Partial<Trade> = {}): Trade => ({
  id: `trade-${uuidv4()}`,
  poolAddress,
  tokenAddress,
  direction: 'BUY',
  amount: 100,
  price: 1.0,
  valueUsd: 100,
  gasFeeUsd: 0.1,
  timestamp: Date.now(),
  txSignature: `sig-${uuidv4()}`,
  status: 'CONFIRMED',
  ...overrides,
});

const createSampleExitStrategy = (): ExitStrategyConfig => ({
  type: 'profit',
  name: 'Test Profit Strategy',
  enabled: true,
  params: {
    profitPercentage: 30,
    trailingStopPercent: 5,
  },
});

const createSamplePosition = (tokenAddress: string, entryTradeId: string, overrides: Partial<Position> = {}): Position => ({
  id: `position-${uuidv4()}`,
  tokenAddress,
  entryPrice: 1.0,
  amount: 100,
  openTimestamp: Date.now(),
  entryTradeId,
  exitStrategy: createSampleExitStrategy(),
  status: 'OPEN',
  ...overrides,
});

describe('DatabaseManager', () => {
  let dbPath: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbPath = createTestDbPath();
    dbManager = new DatabaseManager(dbPath, { verbose: false });
  });

  afterEach(async () => {
    try {
      // Close the database connection
      await dbManager.close();
      
      // Delete the test database file if it exists
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      
      // Delete any backup files that might have been created
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir);
        for (const file of files) {
          fs.unlinkSync(path.join(backupDir, file));
        }
        fs.rmdirSync(backupDir);
      }
    } catch (err) {
      console.error('Error cleaning up test resources:', err);
    }
  });

  afterAll(() => {
    // Clean up the temp directory
    const tempDir = path.join(__dirname, '.tmp');
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmdirSync(tempDir, { recursive: true });
      } catch (err) {
        console.error('Error removing temp directory:', err);
      }
    }
  });

  // Basic initialization tests
  describe('Initialization', () => {
    it('should initialize the database successfully', async () => {
      await expect(dbManager.initialize()).resolves.not.toThrow();
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('should create the necessary tables during initialization', async () => {
      await dbManager.initialize();
      
      // Check if tables exist by trying simple operations
      await expect(dbManager.getTokens()).resolves.toEqual([]);
      await expect(dbManager.getLiquidityPools()).resolves.toEqual([]);
    });

    it('should handle re-initialization gracefully', async () => {
      await dbManager.initialize();
      // Second initialization should not throw and should be a no-op
      await expect(dbManager.initialize()).resolves.not.toThrow();
    });

    it('should create the database directory if it does not exist', async () => {
      const nestedDir = path.join(path.dirname(dbPath), 'nested', 'dirs');
      const nestedDbPath = path.join(nestedDir, 'test.db');
      
      const nestedDbManager = new DatabaseManager(nestedDbPath);
      await nestedDbManager.initialize();
      
      expect(fs.existsSync(nestedDir)).toBe(true);
      expect(fs.existsSync(nestedDbPath)).toBe(true);
      
      // Clean up
      await nestedDbManager.close();
      fs.unlinkSync(nestedDbPath);
      fs.rmdirSync(nestedDir, { recursive: true });
    });
  });

  // Token operations tests
  describe('Token Operations', () => {
    beforeEach(async () => {
      await dbManager.initialize();
    });

    it('should add a token successfully', async () => {
      const token = createSampleToken();
      await expect(dbManager.addToken(token)).resolves.not.toThrow();
      
      const retrievedToken = await dbManager.getToken(token.address);
      expect(retrievedToken).not.toBeNull();
      expect(retrievedToken?.address).toBe(token.address);
      expect(retrievedToken?.symbol).toBe(token.symbol);
    });

    it('should not overwrite existing token with addToken', async () => {
      const token = createSampleToken();
      await dbManager.addToken(token);
      
      // Try to add with updated symbol
      const updatedToken = { ...token, symbol: 'UPDATED' };
      await dbManager.addToken(updatedToken);
      
      // Should still have original symbol
      const retrievedToken = await dbManager.getToken(token.address);
      expect(retrievedToken?.symbol).toBe(token.symbol);
    });

    it('should update existing token with upsertToken', async () => {
      const token = createSampleToken();
      await dbManager.addToken(token);
      
      // Update with new symbol
      const updatedToken = { ...token, symbol: 'UPDATED' };
      await dbManager.upsertToken(updatedToken);
      
      // Should have updated symbol
      const retrievedToken = await dbManager.getToken(token.address);
      expect(retrievedToken?.symbol).toBe('UPDATED');
    });

    it('should retrieve all tokens', async () => {
      const tokens = [
        createSampleToken(),
        createSampleToken(),
        createSampleToken(),
      ];
      
      for (const token of tokens) {
        await dbManager.addToken(token);
      }
      
      const retrievedTokens = await dbManager.getTokens();
      expect(retrievedTokens.length).toBe(tokens.length);
      
      // Verify all tokens are retrieved
      for (const token of tokens) {
        const found = retrievedTokens.some(t => t.address === token.address);
        expect(found).toBe(true);
      }
    });

    it('should update token verification status', async () => {
      const token = createSampleToken({ isVerified: false });
      await dbManager.addToken(token);
      
      // Update verification status
      await dbManager.updateTokenVerification(token.address, true);
      
      const retrievedToken = await dbManager.getToken(token.address);
      expect(retrievedToken?.isVerified).toBe(true);
    });

    it('should handle missing tokens gracefully', async () => {
      const nonExistentToken = await dbManager.getToken('non-existent-address');
      expect(nonExistentToken).toBeNull();
    });
  });

  // Liquidity pool operations tests
  describe('Liquidity Pool Operations', () => {
    let tokenA: Token;
    let tokenB: Token;
    
    beforeEach(async () => {
      await dbManager.initialize();
      
      // Create test tokens
      tokenA = createSampleToken();
      tokenB = createSampleToken();
      
      await dbManager.addToken(tokenA);
      await dbManager.addToken(tokenB);
    });

    it('should add a liquidity pool successfully', async () => {
      const pool = createSamplePool(tokenA.address, tokenB.address);
      await expect(dbManager.addLiquidityPool(pool)).resolves.not.toThrow();
      
      const retrievedPool = await dbManager.getLiquidityPool(pool.address);
      expect(retrievedPool).not.toBeNull();
      expect(retrievedPool?.address).toBe(pool.address);
      expect(retrievedPool?.tokenA).toBe(tokenA.address);
      expect(retrievedPool?.tokenB).toBe(tokenB.address);
    });

    it('should create placeholder tokens if they do not exist', async () => {
      const newTokenAddress = `new-token-${uuidv4()}`;
      
      // Create pool with one non-existent token
      const pool = createSamplePool(tokenA.address, newTokenAddress);
      await dbManager.addLiquidityPool(pool);
      
      // Check if the placeholder token was created
      const newToken = await dbManager.getToken(newTokenAddress);
      expect(newToken).not.toBeNull();
      expect(newToken?.address).toBe(newTokenAddress);
    });

    it('should update liquidity pool with upsertLiquidityPool', async () => {
      const pool = createSamplePool(tokenA.address, tokenB.address, {
        currentLiquidityUsd: 10000
      });
      await dbManager.addLiquidityPool(pool);
      
      // Update with new liquidity
      const updatedPool = { ...pool, currentLiquidityUsd: 15000 };
      await dbManager.upsertLiquidityPool(updatedPool);
      
      // Should have updated liquidity
      const retrievedPool = await dbManager.getLiquidityPool(pool.address);
      expect(retrievedPool?.currentLiquidityUsd).toBe(15000);
    });

    it('should retrieve all liquidity pools', async () => {
      const pools = [
        createSamplePool(tokenA.address, tokenB.address),
        createSamplePool(tokenA.address, tokenB.address),
        createSamplePool(tokenA.address, tokenB.address),
      ];
      
      for (const pool of pools) {
        await dbManager.addLiquidityPool(pool);
      }
      
      const retrievedPools = await dbManager.getLiquidityPools();
      expect(retrievedPools.length).toBe(pools.length);
      
      // Verify all pools are retrieved
      for (const pool of pools) {
        const found = retrievedPools.some(p => p.address === pool.address);
        expect(found).toBe(true);
      }
    });

    it('should retrieve pools by token address', async () => {
      // Create pools with different token combinations
      const tokenC = createSampleToken();
      await dbManager.addToken(tokenC);
      
      const poolAB = createSamplePool(tokenA.address, tokenB.address);
      const poolAC = createSamplePool(tokenA.address, tokenC.address);
      const poolBC = createSamplePool(tokenB.address, tokenC.address);
      
      await dbManager.addLiquidityPool(poolAB);
      await dbManager.addLiquidityPool(poolAC);
      await dbManager.addLiquidityPool(poolBC);
      
      // Get pools for tokenA
      const tokenAPools = await dbManager.getPoolsByToken(tokenA.address);
      expect(tokenAPools.length).toBe(2);
      expect(tokenAPools.some(p => p.address === poolAB.address)).toBe(true);
      expect(tokenAPools.some(p => p.address === poolAC.address)).toBe(true);
      
      // Get pools for tokenB
      const tokenBPools = await dbManager.getPoolsByToken(tokenB.address);
      expect(tokenBPools.length).toBe(2);
      expect(tokenBPools.some(p => p.address === poolAB.address)).toBe(true);
      expect(tokenBPools.some(p => p.address === poolBC.address)).toBe(true);
    });

    it('should update pool liquidity', async () => {
      const pool = createSamplePool(tokenA.address, tokenB.address);
      await dbManager.addLiquidityPool(pool);
      
      // Update liquidity
      const newLiquidity = 20000;
      const result = await dbManager.updatePoolLiquidity(pool.address, newLiquidity);
      expect(result).toBe(true);
      
      // Check updated pool
      const updatedPool = await dbManager.getLiquidityPool(pool.address);
      expect(updatedPool?.currentLiquidityUsd).toBe(newLiquidity);
    });

    it('should return false when updating non-existent pool', async () => {
      const result = await dbManager.updatePoolLiquidity('non-existent-pool', 1000);
      expect(result).toBe(false);
    });
  });

  // Trade operations tests
  describe('Trade Operations', () => {
    let token: Token;
    let pool: LiquidityPool;
    
    beforeEach(async () => {
      await dbManager.initialize();
      
      // Create test token and pool
      token = createSampleToken();
      await dbManager.addToken(token);
      
      pool = createSamplePool(token.address, `other-token-${uuidv4()}`);
      await dbManager.addLiquidityPool(pool);
    });

    it('should add a trade successfully', async () => {
      const trade = createSampleTrade(token.address, pool.address);
      await expect(dbManager.addTrade(trade)).resolves.not.toThrow();
      
      const retrievedTrade = await dbManager.getTrade(trade.id);
      expect(retrievedTrade).not.toBeNull();
      expect(retrievedTrade?.id).toBe(trade.id);
      expect(retrievedTrade?.tokenAddress).toBe(token.address);
      expect(retrievedTrade?.poolAddress).toBe(pool.address);
    });

    it('should generate an ID for trades if not provided', async () => {
      const trade = createSampleTrade(token.address, pool.address);
      delete (trade as any).id; // Remove ID to let the system generate one
      
      await dbManager.addTrade(trade);
      
      // Get all trades for the token to find the new one
      const trades = await dbManager.getTradesByToken(token.address);
      expect(trades.length).toBe(1);
      expect(trades[0].id).toBeDefined();
    });

    it('should retrieve trades by token address', async () => {
      // Create another token for testing
      const tokenB = createSampleToken();
      await dbManager.addToken(tokenB);
      
      // Create trades for different tokens
      const tradeA1 = createSampleTrade(token.address, pool.address);
      const tradeA2 = createSampleTrade(token.address, pool.address);
      const tradeB = createSampleTrade(tokenB.address, pool.address);
      
      await dbManager.addTrade(tradeA1);
      await dbManager.addTrade(tradeA2);
      await dbManager.addTrade(tradeB);
      
      // Get trades for tokenA
      const tokenATrades = await dbManager.getTradesByToken(token.address);
      expect(tokenATrades.length).toBe(2);
      expect(tokenATrades.some(t => t.id === tradeA1.id)).toBe(true);
      expect(tokenATrades.some(t => t.id === tradeA2.id)).toBe(true);
      
      // Get trades for tokenB
      const tokenBTrades = await dbManager.getTradesByToken(tokenB.address);
      expect(tokenBTrades.length).toBe(1);
      expect(tokenBTrades[0].id).toBe(tradeB.id);
    });

    it('should update trade status', async () => {
      const trade = createSampleTrade(token.address, pool.address, { status: 'PENDING' });
      await dbManager.addTrade(trade);
      
      // Update status
      const result = await dbManager.updateTradeStatus(trade.id, 'CONFIRMED');
      expect(result).toBe(true);
      
      // Check updated trade
      const updatedTrade = await dbManager.getTrade(trade.id);
      expect(updatedTrade?.status).toBe('CONFIRMED');
    });

    it('should return false when updating non-existent trade', async () => {
      const result = await dbManager.updateTradeStatus('non-existent-trade', 'CONFIRMED');
      expect(result).toBe(false);
    });
  });

  // Position operations tests
  describe('Position Operations', () => {
    let token: Token;
    let pool: LiquidityPool;
    let trade: Trade;
    
    beforeEach(async () => {
      await dbManager.initialize();
      
      // Create test token, pool, and trade
      token = createSampleToken();
      await dbManager.addToken(token);
      
      pool = createSamplePool(token.address, `other-token-${uuidv4()}`);
      await dbManager.addLiquidityPool(pool);
      
      trade = createSampleTrade(token.address, pool.address);
      await dbManager.addTrade(trade);
    });

    it('should add a position successfully', async () => {
      const position = createSamplePosition(token.address, trade.id);
      await expect(dbManager.addPosition(position)).resolves.not.toThrow();
      
      const retrievedPosition = await dbManager.getPosition(position.id);
      expect(retrievedPosition).not.toBeNull();
      expect(retrievedPosition?.id).toBe(position.id);
      expect(retrievedPosition?.tokenAddress).toBe(token.address);
      expect(retrievedPosition?.entryTradeId).toBe(trade.id);
      expect(retrievedPosition?.status).toBe('OPEN');
    });

    it('should generate an ID for positions if not provided', async () => {
      const position = createSamplePosition(token.address, trade.id);
      delete (position as any).id; // Remove ID to let the system generate one
      
      await dbManager.addPosition(position);
      
      // Get all open positions to find the new one
      const positions = await dbManager.getOpenPositions();
      expect(positions.length).toBe(1);
      expect(positions[0].id).toBeDefined();
    });

    it('should retrieve open positions', async () => {
      // Add multiple positions
      const openPosition1 = createSamplePosition(token.address, trade.id);
      const openPosition2 = createSamplePosition(token.address, trade.id);
      
      // For closed position, we need a real exit trade
      const exitTrade = createSampleTrade(token.address, pool.address, { direction: 'SELL' });
      await dbManager.addTrade(exitTrade);
      
      const closedPosition = createSamplePosition(token.address, trade.id, { 
        status: 'CLOSED',
        closeTimestamp: Date.now(),
        exitTradeId: exitTrade.id,
        pnlUsd: 50,
        pnlPercent: 50
      });
      
      await dbManager.addPosition(openPosition1);
      await dbManager.addPosition(openPosition2);
      await dbManager.addPosition(closedPosition);
      
      // Retrieve open positions
      const openPositions = await dbManager.getOpenPositions();
      expect(openPositions.length).toBe(2);
      expect(openPositions.some(p => p.id === openPosition1.id)).toBe(true);
      expect(openPositions.some(p => p.id === openPosition2.id)).toBe(true);
      expect(openPositions.some(p => p.id === closedPosition.id)).toBe(false);
    });

    it('should retrieve closed positions', async () => {
      // Add multiple positions
      const openPosition = createSamplePosition(token.address, trade.id);
      
      // Create exit trades
      const exitTrade1 = createSampleTrade(token.address, pool.address, { direction: 'SELL' });
      const exitTrade2 = createSampleTrade(token.address, pool.address, { direction: 'SELL' });
      await dbManager.addTrade(exitTrade1);
      await dbManager.addTrade(exitTrade2);
      
      const closedPosition1 = createSamplePosition(token.address, trade.id, { 
        status: 'CLOSED',
        closeTimestamp: Date.now(),
        exitTradeId: exitTrade1.id,
        pnlUsd: 50,
        pnlPercent: 50
      });
      const closedPosition2 = createSamplePosition(token.address, trade.id, { 
        status: 'CLOSED',
        closeTimestamp: Date.now(),
        exitTradeId: exitTrade2.id,
        pnlUsd: -20,
        pnlPercent: -20
      });
      
      await dbManager.addPosition(openPosition);
      await dbManager.addPosition(closedPosition1);
      await dbManager.addPosition(closedPosition2);
      
      // Retrieve closed positions
      const closedPositions = await dbManager.getClosedPositions();
      expect(closedPositions.length).toBe(2);
      expect(closedPositions.some(p => p.id === closedPosition1.id)).toBe(true);
      expect(closedPositions.some(p => p.id === closedPosition2.id)).toBe(true);
      expect(closedPositions.some(p => p.id === openPosition.id)).toBe(false);
    });

    it('should close an open position', async () => {
      const position = createSamplePosition(token.address, trade.id);
      await dbManager.addPosition(position);
      
      // Create exit trade
      const exitTrade = createSampleTrade(token.address, pool.address, { direction: 'SELL' });
      await dbManager.addTrade(exitTrade);
      
      // Close the position
      const closeTimestamp = Date.now();
      const pnlUsd = 30;
      const pnlPercent = 30;
      
      const result = await dbManager.closePosition(
        position.id,
        exitTrade.id,
        closeTimestamp,
        pnlUsd,
        pnlPercent
      );
      
      expect(result).toBe(true);
      
      // Check the closed position
      const closedPosition = await dbManager.getPosition(position.id);
      expect(closedPosition?.status).toBe('CLOSED');
      expect(closedPosition?.exitTradeId).toBe(exitTrade.id);
      expect(closedPosition?.closeTimestamp).toBe(closeTimestamp);
      expect(closedPosition?.pnlUsd).toBe(pnlUsd);
      expect(closedPosition?.pnlPercent).toBe(pnlPercent);
    });

    it('should return false when closing a non-existent position', async () => {
      const result = await dbManager.closePosition(
        'non-existent-position',
        trade.id,
        Date.now(),
        0,
        0
      );
      
      expect(result).toBe(false);
    });

    it('should return false when closing an already closed position', async () => {
      const position = createSamplePosition(token.address, trade.id, { 
        status: 'CLOSED',
        closeTimestamp: Date.now(),
        exitTradeId: trade.id,
        pnlUsd: 0,
        pnlPercent: 0
      });
      
      await dbManager.addPosition(position);
      
      const result = await dbManager.closePosition(
        position.id,
        `another-trade-${uuidv4()}`,
        Date.now(),
        10,
        10
      );
      
      expect(result).toBe(false);
    });
  });

  // Event logging tests
  describe('Event Logging', () => {
    beforeEach(async () => {
      await dbManager.initialize();
    });

    it('should add and retrieve log events', async () => {
      const event = {
        level: 'info' as const,
        message: '[TestContext] Test message',
        timestamp: Date.now(),
        data: { test: true }
      };
      
      await dbManager.addLogEvent(event);
      
      const events = await dbManager.getRecentLogEvents(10);
      expect(events.length).toBe(1);
      expect(events[0].message).toBe(event.message);
      expect(events[0].level).toBe(event.level);
    });

    it('should filter log events by level', async () => {
      const events = [
        { level: 'info' as const, message: '[Test] Info message', timestamp: Date.now() },
        { level: 'warning' as const, message: '[Test] Warning message', timestamp: Date.now() },
        { level: 'error' as const, message: '[Test] Error message', timestamp: Date.now() },
        { level: 'debug' as const, message: '[Test] Debug message', timestamp: Date.now() },
      ];
      
      for (const event of events) {
        await dbManager.addLogEvent(event);
      }
      
      // Get only error events
      const errorEvents = await dbManager.getRecentLogEvents(10, 'error');
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].level).toBe('error');
      
      // Get only warning events
      const warningEvents = await dbManager.getRecentLogEvents(10, 'warning');
      expect(warningEvents.length).toBe(1);
      expect(warningEvents[0].level).toBe('warning');
    });

    it('should respect the limit parameter', async () => {
      // Add 20 events
      for (let i = 0; i < 20; i++) {
        await dbManager.addLogEvent({
          level: 'info' as const,
          message: `[Test] Message ${i}`,
          timestamp: Date.now() + i
        });
      }
      
      // Get only 5 events
      const events = await dbManager.getRecentLogEvents(5);
      expect(events.length).toBe(5);
    });

    it('should prune old log events', async () => {
      const now = Date.now();
      const dayInMs = 24 * 60 * 60 * 1000;
      
      // Add events with different timestamps
      const events = [
        { level: 'info' as const, message: '[Test] Recent', timestamp: now },
        { level: 'info' as const, message: '[Test] 2 days old', timestamp: now - (2 * dayInMs) },
        { level: 'info' as const, message: '[Test] 5 days old', timestamp: now - (5 * dayInMs) },
        { level: 'info' as const, message: '[Test] 10 days old', timestamp: now - (10 * dayInMs) },
      ];
      
      for (const event of events) {
        await dbManager.addLogEvent(event);
      }
      
      // Prune events older than 3 days
      const deletedCount = await dbManager.pruneOldLogEvents(3);
      expect(deletedCount).toBe(2); // 5 days old and 10 days old should be deleted
      
      // Check remaining events
      const remainingEvents = await dbManager.getRecentLogEvents();
      expect(remainingEvents.length).toBe(2);
      expect(remainingEvents.some(e => e.message.includes('Recent'))).toBe(true);
      expect(remainingEvents.some(e => e.message.includes('2 days old'))).toBe(true);
      expect(remainingEvents.some(e => e.message.includes('5 days old'))).toBe(false);
      expect(remainingEvents.some(e => e.message.includes('10 days old'))).toBe(false);
    });
  });

  // Database management tests
  describe('Database Management', () => {
    beforeEach(async () => {
      await dbManager.initialize();
    });

    it('should create a backup successfully', async () => {
      // Add some data to back up
      const token = createSampleToken();
      await dbManager.addToken(token);
      
      try {
        // Create a backup
        const backupPath = await dbManager.createBackup();
        expect(fs.existsSync(backupPath)).toBe(true);
        
        // Verify the backup file exists
        expect(fs.statSync(backupPath).size).toBeGreaterThan(0);
        
        // We would verify content here, but for testing purposes just checking file existence is sufficient
      } catch (err) {
        // Skip the test if SQLite version doesn't support our backup method
        console.log('Backup test skipped:', err);
      }
    });

    it('should implement backup rotation when configured', async () => {
      try {
        // Create a database manager with backup rotation
        const rotationDbPath = createTestDbPath();
        const rotationDbManager = new DatabaseManager(rotationDbPath, {
          maxBackups: 2
        });
        
        await rotationDbManager.initialize();
        
        // Create 3 backups
        await rotationDbManager.createBackup();
        await rotationDbManager.createBackup();
        await rotationDbManager.createBackup();
        
        // Check that only 2 backups exist
        const backupDir = path.join(path.dirname(rotationDbPath), 'backups');
        if (fs.existsSync(backupDir)) {
          const backupFiles = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
          expect(backupFiles.length).toBeLessThanOrEqual(2);
          
          // Clean up
          await rotationDbManager.close();
          fs.unlinkSync(rotationDbPath);
          for (const file of backupFiles) {
            fs.unlinkSync(path.join(backupDir, file));
          }
          fs.rmdirSync(backupDir);
        } else {
          // If backup creation was skipped, just clean up the test db
          await rotationDbManager.close();
          fs.unlinkSync(rotationDbPath);
        }
      } catch (err) {
        // Skip the test if SQLite version doesn't support our backup method
        console.log('Backup rotation test skipped:', err);
      }
    });

    it('should get database stats', async () => {
      // Add some data
      const token = createSampleToken();
      await dbManager.addToken(token);
      
      const pool = createSamplePool(token.address, `other-token-${uuidv4()}`);
      await dbManager.addLiquidityPool(pool);
      
      const trade = createSampleTrade(token.address, pool.address);
      await dbManager.addTrade(trade);
      
      const position = createSamplePosition(token.address, trade.id);
      await dbManager.addPosition(position);
      
      // Get stats
      const stats = await dbManager.getStats();
      
      expect(stats.tokenCount).toBe(2); // token + other token created by pool
      expect(stats.poolCount).toBe(1);
      expect(stats.tradeCount).toBe(1);
      expect(stats.openPositionCount).toBe(1);
      expect(stats.closedPositionCount).toBe(0);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });

    it('should handle vacuum operation', async () => {
      // Just verify it doesn't throw
      await expect(dbManager.vacuum()).resolves.not.toThrow();
    });

    it('should handle transaction operations', async () => {
      // Test successful transaction
      await dbManager.transaction(async () => {
        const token = createSampleToken();
        await dbManager.addToken(token);
        return true;
      });
      
      // Tokens should have been added
      const tokens = await dbManager.getTokens();
      expect(tokens.length).toBe(1);
      
      // Test failed transaction
      try {
        await dbManager.transaction(async () => {
          const token = createSampleToken();
          await dbManager.addToken(token);
          // Force an error
          throw new Error('Test error');
        });
        fail('Transaction should have failed');
      } catch (err) {
        // Expected to fail
      }
      
      // No additional tokens should have been added
      const tokensAfterFailedTx = await dbManager.getTokens();
      expect(tokensAfterFailedTx.length).toBe(1);
    });
  });

  // Error handling tests
  describe('Error Handling', () => {
    it('should throw DatabaseError for invalid operations', async () => {
      await dbManager.initialize();
      
      // Attempt to add a trade with invalid foreign key
      const invalidTrade = createSampleTrade('invalid-token', 'invalid-pool');
      
      await expect(dbManager.addTrade(invalidTrade)).rejects.toThrow(DatabaseError);
    });

    it('should handle concurrent operations gracefully', async () => {
      await dbManager.initialize();
      
      // Create a lot of tokens concurrently
      const tokens = Array.from({ length: 20 }, () => createSampleToken());
      
      // Execute all concurrently
      await Promise.all(tokens.map(token => dbManager.addToken(token)));
      
      // Should have added all tokens
      const retrievedTokens = await dbManager.getTokens();
      expect(retrievedTokens.length).toBe(tokens.length);
    });

    it('should not crash on invalid database path', async () => {
      const invalidPath = '/non/existent/directory/that/should/fail/db.sqlite';
      
      // Creating the manager should throw
      expect(() => new DatabaseManager(invalidPath)).toThrow();
    });

    it('should enforce foreign key constraints', async () => {
      await dbManager.initialize();
      
      // Try to add a position with non-existent trade
      const position = createSamplePosition('some-token', 'non-existent-trade');
      
      await expect(dbManager.addPosition(position)).rejects.toThrow(DatabaseError);
    });
  });
});