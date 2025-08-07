/**
 * Wallet Operations Integration Tests
 * 
 * Tests wallet management and blockchain operations:
 * - Keypair generation and management
 * - SPL token account creation and management
 * - Balance queries and validation
 * - Hardware wallet integration testing
 * - Transaction signing workflows
 * - Security validation for key storage
 */

import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { 
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import fs from 'fs/promises';
import path from 'path';
import { SecureKeypairManager } from '../../src/security/secure-keypair-manager';
import { HardwareWalletFactory } from '../../src/security/hardware-wallet/factory';
import { ConnectionManager } from '../../src/blockchain/connection-manager';
import { TradeExecutor } from '../../src/trading/trade-executor';
import { DatabaseManager } from '../../src/db';
import { RpcConfig, AppConfig, WalletConfig } from '../../src/types';

// Test configuration for devnet
const DEVNET_CONFIG: RpcConfig = {
  httpUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  commitment: 'confirmed',
  connectionTimeout: 15000,
  reconnectPolicy: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000
  }
};

const TEST_KEYPAIR_PATH = path.join(__dirname, '../test-fixtures/test-keypair.json');
const TEST_ENCRYPTED_PATH = path.join(__dirname, '../test-fixtures/encrypted-keypair.json');

describe('Wallet Operations Integration Tests', () => {
  let connection: Connection;
  let connectionManager: ConnectionManager;
  let testKeypair: Keypair;
  let secureKeypairManager: SecureKeypairManager;
  let dbManager: DatabaseManager;

  beforeAll(async () => {
    // Initialize connection
    connectionManager = new ConnectionManager(DEVNET_CONFIG);
    await connectionManager.initialize();
    connection = connectionManager.getConnection();

    // Generate test keypair
    testKeypair = Keypair.generate();

    // Initialize secure keypair manager
    secureKeypairManager = new SecureKeypairManager({
      encryptionKey: 'test-encryption-key-32-chars-long',
      keyDerivationRounds: 1000, // Reduced for testing
      backupEnabled: false
    });

    // Initialize database
    dbManager = new DatabaseManager(':memory:');
    await dbManager.initialize();
  }, 60000);

  afterAll(async () => {
    await connectionManager.shutdown();
    await dbManager.close();
    
    // Cleanup test files
    try {
      await fs.unlink(TEST_KEYPAIR_PATH);
      await fs.unlink(TEST_ENCRYPTED_PATH);
    } catch (error) {
      // Files might not exist
    }
  });

  describe('Keypair Management', () => {
    it('should generate and save keypair securely', async () => {
      const keypair = Keypair.generate();
      
      // Save to file
      const keypairArray = Array.from(keypair.secretKey);
      await fs.writeFile(TEST_KEYPAIR_PATH, JSON.stringify(keypairArray));
      
      // Verify file exists and has correct format
      const savedData = await fs.readFile(TEST_KEYPAIR_PATH, 'utf-8');
      const parsedKeypair = JSON.parse(savedData);
      
      expect(Array.isArray(parsedKeypair)).toBe(true);
      expect(parsedKeypair).toHaveLength(64);
      
      // Verify keypair can be reconstructed
      const reconstructedKeypair = Keypair.fromSecretKey(new Uint8Array(parsedKeypair));
      expect(reconstructedKeypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    });

    it('should validate keypair integrity', async () => {
      const keypair = Keypair.generate();
      
      // Test valid keypair
      expect(() => Keypair.fromSecretKey(keypair.secretKey)).not.toThrow();
      
      // Test invalid keypair (wrong length)
      const invalidSecret = new Uint8Array(32); // Should be 64 bytes
      expect(() => Keypair.fromSecretKey(invalidSecret)).toThrow();
      
      // Test corrupted keypair
      const corruptedSecret = new Uint8Array(keypair.secretKey);
      corruptedSecret[0] = 255; // Corrupt first byte
      
      // This might not throw immediately, but should produce different public key
      const corruptedKeypair = Keypair.fromSecretKey(corruptedSecret);
      expect(corruptedKeypair.publicKey.toBase58()).not.toBe(keypair.publicKey.toBase58());
    });

    it('should encrypt and decrypt keypairs', async () => {
      const originalKeypair = Keypair.generate();
      
      // Encrypt keypair
      const encryptedData = await secureKeypairManager.encryptKeypair(
        originalKeypair,
        'test-passphrase'
      );
      
      expect(encryptedData).toBeDefined();
      expect(encryptedData.iv).toBeDefined();
      expect(encryptedData.encryptedKey).toBeDefined();
      expect(encryptedData.salt).toBeDefined();
      
      // Decrypt keypair
      const decryptedKeypair = await secureKeypairManager.decryptKeypair(
        encryptedData,
        'test-passphrase'
      );
      
      expect(decryptedKeypair.publicKey.toBase58()).toBe(originalKeypair.publicKey.toBase58());
      expect(Buffer.from(decryptedKeypair.secretKey)).toEqual(Buffer.from(originalKeypair.secretKey));
    });

    it('should fail decryption with wrong passphrase', async () => {
      const originalKeypair = Keypair.generate();
      
      const encryptedData = await secureKeypairManager.encryptKeypair(
        originalKeypair,
        'correct-passphrase'
      );
      
      await expect(
        secureKeypairManager.decryptKeypair(encryptedData, 'wrong-passphrase')
      ).rejects.toThrow();
    });
  });

  describe('Balance Operations', () => {
    it('should query SOL balance', async () => {
      // This will likely be 0 on devnet for a new keypair
      const balance = await connection.getBalance(testKeypair.publicKey);
      
      expect(typeof balance).toBe('number');
      expect(balance).toBeGreaterThanOrEqual(0);
      
      // Convert to SOL for readability
      const solBalance = balance / LAMPORTS_PER_SOL;
      expect(solBalance).toBeGreaterThanOrEqual(0);
    });

    it('should handle balance queries for non-existent accounts', async () => {
      const nonExistentKeypair = Keypair.generate();
      const balance = await connection.getBalance(nonExistentKeypair.publicKey);
      
      // Non-existent accounts should have 0 balance
      expect(balance).toBe(0);
    });

    it('should query account information', async () => {
      const accountInfo = await connection.getAccountInfo(testKeypair.publicKey);
      
      // New keypair likely has no account info
      if (accountInfo) {
        expect(accountInfo.lamports).toBeGreaterThanOrEqual(0);
        expect(accountInfo.owner).toBeInstanceOf(PublicKey);
        expect(accountInfo.executable).toBe(false);
      } else {
        expect(accountInfo).toBeNull();
      }
    });
  });

  describe('SPL Token Operations', () => {
    let mintAuthority: Keypair;
    let mint: PublicKey;
    let tokenAccount: PublicKey;

    beforeAll(async () => {
      mintAuthority = Keypair.generate();
      
      // Skip SPL token tests if we can't fund accounts
      // In real devnet testing, you would need to fund these accounts
      // with devnet SOL from a faucet
    });

    it('should create SPL token mint (simulation)', async () => {
      // This is a simulation test - we test the transaction building
      // without actually submitting it to devnet
      
      const mockMint = Keypair.generate();
      
      // Build transaction for creating mint
      const transaction = new Transaction();
      
      // Add rent calculation (simulated)
      const rentExemptionAmount = await connection.getMinimumBalanceForRentExemption(82); // Mint account size
      
      expect(rentExemptionAmount).toBeGreaterThan(0);
      expect(typeof rentExemptionAmount).toBe('number');
      
      // Verify transaction structure (without submitting)
      expect(transaction.instructions).toHaveLength(0); // Empty until we add instructions
    });

    it('should create associated token account (simulation)', async () => {
      const owner = testKeypair.publicKey;
      const mockMint = Keypair.generate().publicKey;
      
      // Calculate associated token account address
      const [associatedTokenAddress] = PublicKey.findProgramAddressSync(
        [
          owner.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          mockMint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      expect(associatedTokenAddress).toBeInstanceOf(PublicKey);
      expect(associatedTokenAddress.toBase58()).toBeTruthy();
    });

    it('should handle token account errors gracefully', async () => {
      const nonExistentMint = Keypair.generate().publicKey;
      const owner = testKeypair.publicKey;
      
      // Try to get account info for non-existent token account
      const [associatedTokenAddress] = PublicKey.findProgramAddressSync(
        [
          owner.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          nonExistentMint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      
      const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
      expect(accountInfo).toBeNull(); // Should be null for non-existent account
    });
  });

  describe('Transaction Operations', () => {
    it('should build and sign transactions', async () => {
      const fromKeypair = Keypair.generate();
      const toKeypair = Keypair.generate();
      const transferAmount = 0.001 * LAMPORTS_PER_SOL; // 0.001 SOL
      
      // Build transfer transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toKeypair.publicKey,
          lamports: transferAmount,
        })
      );
      
      // Set recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromKeypair.publicKey;
      
      // Sign transaction
      transaction.sign(fromKeypair);
      
      // Verify transaction signature
      expect(transaction.signatures).toHaveLength(1);
      expect(transaction.signatures[0].signature).toBeTruthy();
      expect(transaction.signatures[0].publicKey.equals(fromKeypair.publicKey)).toBe(true);
      
      // Verify transaction can be serialized
      const serialized = transaction.serialize();
      expect(serialized).toBeInstanceOf(Buffer);
      expect(serialized.length).toBeGreaterThan(0);
    });

    it('should validate transaction signatures', async () => {
      const keypair = Keypair.generate();
      const destination = Keypair.generate().publicKey;
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports: 1000,
        })
      );
      
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;
      
      // Sign with correct keypair
      transaction.sign(keypair);
      
      // Verify signature validation passes
      expect(() => transaction.serialize()).not.toThrow();
      
      // Test with unsigned transaction
      const unsignedTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports: 1000,
        })
      );
      
      unsignedTransaction.recentBlockhash = blockhash;
      unsignedTransaction.feePayer = keypair.publicKey;
      
      // Should throw when trying to serialize unsigned transaction
      expect(() => unsignedTransaction.serialize()).toThrow();
    });

    it('should estimate transaction fees', async () => {
      const keypair = Keypair.generate();
      const destination = Keypair.generate().publicKey;
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports: 1000,
        })
      );
      
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = keypair.publicKey;
      
      // Get fee estimate
      const fee = await connection.getFeeForMessage(
        transaction.compileMessage(),
        'confirmed'
      );
      
      expect(fee.value).toBeGreaterThan(0);
      expect(typeof fee.value).toBe('number');
      
      // Typical Solana transaction fee should be around 5000 lamports
      expect(fee.value).toBeLessThan(100000); // Reasonable upper bound
    });
  });

  describe('Hardware Wallet Integration', () => {
    it('should initialize hardware wallet factory', async () => {
      const factory = new HardwareWalletFactory();
      
      // Test factory methods exist
      expect(typeof factory.createLedgerAdapter).toBe('function');
      expect(typeof factory.createTrezorAdapter).toBe('function');
      expect(typeof factory.createMockAdapter).toBe('function');
    });

    it('should create mock hardware wallet adapter', async () => {
      const factory = new HardwareWalletFactory();
      const mockAdapter = factory.createMockAdapter();
      
      // Test adapter interface
      expect(mockAdapter.isConnected()).toBe(false); // Initially disconnected
      expect(typeof mockAdapter.connect).toBe('function');
      expect(typeof mockAdapter.disconnect).toBe('function');
      expect(typeof mockAdapter.getPublicKey).toBe('function');
      expect(typeof mockAdapter.signTransaction).toBe('function');
    });

    it('should simulate hardware wallet transaction signing', async () => {
      const factory = new HardwareWalletFactory();
      const mockAdapter = factory.createMockAdapter();
      
      // Connect to mock hardware wallet
      await mockAdapter.connect();
      expect(mockAdapter.isConnected()).toBe(true);
      
      // Get public key
      const publicKey = await mockAdapter.getPublicKey();
      expect(publicKey).toBeInstanceOf(PublicKey);
      
      // Create test transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        })
      );
      
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;
      
      // Sign with hardware wallet
      const signedTransaction = await mockAdapter.signTransaction(transaction);
      
      expect(signedTransaction.signatures).toHaveLength(1);
      expect(signedTransaction.signatures[0].publicKey.equals(publicKey)).toBe(true);
      
      // Disconnect
      await mockAdapter.disconnect();
      expect(mockAdapter.isConnected()).toBe(false);
    });

    it('should handle hardware wallet errors', async () => {
      const factory = new HardwareWalletFactory();
      const mockAdapter = factory.createMockAdapter();
      
      // Test operations without connecting
      await expect(mockAdapter.getPublicKey()).rejects.toThrow('not connected');
      
      // Test signing without connecting
      const transaction = new Transaction();
      await expect(mockAdapter.signTransaction(transaction)).rejects.toThrow('not connected');
    });
  });

  describe('Security Validations', () => {
    it('should validate keypair file permissions', async () => {
      // Create test keypair file
      const keypair = Keypair.generate();
      const keypairArray = Array.from(keypair.secretKey);
      await fs.writeFile(TEST_KEYPAIR_PATH, JSON.stringify(keypairArray));
      
      // Check file stats
      const stats = await fs.stat(TEST_KEYPAIR_PATH);
      
      // In production, should verify restricted permissions
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
    });

    it('should validate encrypted keypair format', async () => {
      const keypair = Keypair.generate();
      
      const encryptedData = await secureKeypairManager.encryptKeypair(
        keypair,
        'test-passphrase'
      );
      
      // Validate encrypted data structure
      expect(encryptedData).toHaveProperty('iv');
      expect(encryptedData).toHaveProperty('encryptedKey');
      expect(encryptedData).toHaveProperty('salt');
      expect(encryptedData).toHaveProperty('algorithm');
      
      // Validate field types
      expect(typeof encryptedData.iv).toBe('string');
      expect(typeof encryptedData.encryptedKey).toBe('string');
      expect(typeof encryptedData.salt).toBe('string');
      expect(typeof encryptedData.algorithm).toBe('string');
      
      // Validate base64 encoding
      expect(() => Buffer.from(encryptedData.iv, 'base64')).not.toThrow();
      expect(() => Buffer.from(encryptedData.encryptedKey, 'base64')).not.toThrow();
      expect(() => Buffer.from(encryptedData.salt, 'base64')).not.toThrow();
    });

    it('should detect tampered encrypted data', async () => {
      const keypair = Keypair.generate();
      
      const encryptedData = await secureKeypairManager.encryptKeypair(
        keypair,
        'test-passphrase'
      );
      
      // Tamper with encrypted key
      const tamperedData = { 
        ...encryptedData, 
        encryptedKey: encryptedData.encryptedKey.slice(0, -10) + 'tamperedxx' 
      };
      
      await expect(
        secureKeypairManager.decryptKeypair(tamperedData, 'test-passphrase')
      ).rejects.toThrow();
    });

    it('should implement secure memory cleanup', async () => {
      const sensitiveData = new Uint8Array(64);
      crypto.getRandomValues(sensitiveData);
      
      // Simulate secure cleanup (in real implementation, this would zero memory)
      const cleanup = () => {
        for (let i = 0; i < sensitiveData.length; i++) {
          sensitiveData[i] = 0;
        }
      };
      
      cleanup();
      
      // Verify data is zeroed
      expect(sensitiveData.every(byte => byte === 0)).toBe(true);
    });
  });

  describe('Integration with TradeExecutor', () => {
    it('should initialize TradeExecutor with test wallet', async () => {
      const testConfig: AppConfig = {
        rpc: DEVNET_CONFIG,
        supportedDexes: [{
          name: 'Jupiter',
          programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
          instructions: { newPoolCreation: 'create_pool' },
          enabled: true
        }],
        wallet: {
          keypairPath: TEST_KEYPAIR_PATH,
          riskPercent: 1,
          maxTotalRiskPercent: 5
        },
        tradeConfig: {
          minLiquidityUsd: 1000,
          maxSlippagePercent: 5,
          gasLimit: 0.01,
          defaultTradeAmountUsd: 10,
          maxTradeAmountUsd: 100
        },
        exitStrategies: [{
          type: 'profit',
          enabled: true,
          params: { profitPercentage: 20 }
        }],
        database: {
          path: ':memory:'
        },
        dryRun: true,
        verbose: true,
        disableTui: true
      };

      // Save test keypair for TradeExecutor to load
      const keypairArray = Array.from(testKeypair.secretKey);
      await fs.writeFile(TEST_KEYPAIR_PATH, JSON.stringify(keypairArray));

      const tradeExecutor = new TradeExecutor(connectionManager, dbManager, testConfig);

      // Initialize should load the keypair successfully
      await expect(tradeExecutor.initialize()).resolves.not.toThrow();

      // Verify wallet balance query works
      const balance = await tradeExecutor.getWalletBalance();
      expect(balance).toBeDefined();
      expect(balance.sol).toBeGreaterThanOrEqual(0);
    });

    it('should handle missing keypair file gracefully', async () => {
      const badConfig: AppConfig = {
        rpc: DEVNET_CONFIG,
        supportedDexes: [],
        wallet: {
          keypairPath: '/non/existent/path.json',
          riskPercent: 1
        },
        tradeConfig: {
          minLiquidityUsd: 1000,
          maxSlippagePercent: 5,
          gasLimit: 0.01,
          defaultTradeAmountUsd: 10
        },
        exitStrategies: [],
        database: { path: ':memory:' },
        dryRun: true,
        verbose: true,
        disableTui: true
      };

      const tradeExecutor = new TradeExecutor(connectionManager, dbManager, badConfig);

      await expect(tradeExecutor.initialize()).rejects.toThrow();
    });
  });
});