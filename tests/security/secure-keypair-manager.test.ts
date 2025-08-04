import { Keypair, Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import {
  SecureKeypairManager,
  SecureKeypairConfig,
  SecurityValidationResult,
  SigningOptions
} from '../../src/security/secure-keypair-manager';

// Mock fs module before importing
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn(),
    mkdir: jest.fn(),
  },
}));

// Mock crypto module before importing
jest.mock('crypto', () => ({
  createCipheriv: jest.fn(),
  createDecipheriv: jest.fn(),
  randomBytes: jest.fn(),
  pbkdf2Sync: jest.fn(),
  createHash: jest.fn(),
  createHmac: jest.fn(),
}));

describe('SecureKeypairManager', () => {
  let manager: SecureKeypairManager;
  let testKeypair: Keypair;
  let config: SecureKeypairConfig;

  const testPassword = 'test-password-123!@#';
  const testFilePath = '/tmp/test-keypair.json';

  beforeEach(() => {
    // Test configuration with shorter timeouts for testing
    config = {
      encryptionAlgorithm: 'aes-256-gcm',
      keyDerivationIterations: 1000,
      saltLength: 32,
      ivLength: 12,
      requirePasswordConfirmation: false,
      autoLockTimeoutMs: 100, // Short timeout for testing
      maxFailedAttempts: 3,
      keyRotationIntervalMs: 24 * 60 * 60 * 1000,
    };

    manager = new SecureKeypairManager(config);
    testKeypair = Keypair.generate();

    // Reset all mocks
    jest.clearAllMocks();

    // Setup crypto mocks
    const crypto = require('crypto');
    crypto.randomBytes.mockReturnValue(Buffer.from('randomBytes123456789012345678901'));
    crypto.pbkdf2Sync.mockReturnValue(Buffer.from('derivedKey123456789012345678901234'));
    crypto.createHash.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue(Buffer.from('hashedSeed123456789012345678901234')),
    });
    crypto.createHmac.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('hmacDigest'),
    });
    crypto.createCipheriv.mockReturnValue({
      update: jest.fn().mockReturnValue(Buffer.from('encrypted')),
      final: jest.fn().mockReturnValue(Buffer.from('final')),
      getAuthTag: jest.fn().mockReturnValue(Buffer.from('authTag123456789')),
    });
    crypto.createDecipheriv.mockReturnValue({
      update: jest.fn().mockReturnValue(Buffer.from('decrypted')),
      final: jest.fn().mockReturnValue(Buffer.from('final')),
      setAuthTag: jest.fn(),
    });

    // Setup fs mocks
    const fs = require('fs');
    fs.promises.stat.mockResolvedValue({
      isFile: jest.fn().mockReturnValue(true),
      mode: 0o600,
      size: 1000,
      mtime: new Date(),
    });
    fs.promises.writeFile.mockResolvedValue(undefined);
    fs.promises.mkdir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager.destroy();
    jest.clearAllTimers();
  });

  describe('generateKeypair', () => {
    it('should generate a new keypair with secure entropy', async () => {
      const keypair = await manager.generateKeypair();

      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey).toBeInstanceOf(PublicKey);
      expect(keypair.secretKey).toHaveLength(64);
    });

    it('should generate different keypairs on multiple calls', async () => {
      const keypair1 = await manager.generateKeypair();
      const keypair2 = await manager.generateKeypair();

      expect(keypair1.publicKey.toString()).not.toBe(keypair2.publicKey.toString());
    });
  });

  describe('saveEncryptedKeypair', () => {
    it('should encrypt and save keypair successfully', async () => {
      const fs = require('fs');
      
      await manager.saveEncryptedKeypair(testKeypair, testPassword, testFilePath);

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        testFilePath,
        expect.stringContaining(testKeypair.publicKey.toString()),
        { mode: 0o600 }
      );
    });

    it('should create directory if needed', async () => {
      const fs = require('fs');
      const nestedPath = '/tmp/nested/dir/keypair.json';
      
      await manager.saveEncryptedKeypair(testKeypair, testPassword, nestedPath);
      
      expect(fs.promises.mkdir).toHaveBeenCalledWith('/tmp/nested/dir', { recursive: true, mode: 0o700 });
    });
  });

  describe('loadEncryptedKeypair', () => {
    beforeEach(() => {
      // Mock file content with valid encrypted keypair structure
      const mockEncryptedKeypair = {
        encryptedSecretKey: 'base64EncryptedData',
        salt: 'base64Salt',
        iv: 'base64IV',
        algorithm: 'aes-256-gcm',
        iterations: 1000,
        publicKey: testKeypair.publicKey.toString(),
        metadata: {
          createdAt: Date.now(),
          keyRotations: 0,
        },
      };
      
      const fs = require('fs');
      fs.promises.readFile.mockResolvedValue(JSON.stringify(mockEncryptedKeypair));
    });

    it('should load and decrypt keypair successfully', async () => {
      // Mock successful decryption
      const crypto = require('crypto');
      crypto.createDecipheriv.mockReturnValue({
        update: jest.fn().mockReturnValue(Buffer.from(testKeypair.secretKey.slice(0, 32))),
        final: jest.fn().mockReturnValue(Buffer.from(testKeypair.secretKey.slice(32))),
        setAuthTag: jest.fn(),
      });

      const loadedKeypair = await manager.loadEncryptedKeypair(testPassword, testFilePath);

      expect(loadedKeypair.publicKey.toString()).toBe(testKeypair.publicKey.toString());
      expect(manager.isWalletUnlocked()).toBe(true);
    });

    it('should track failed attempts on wrong password', async () => {
      // Mock decryption failure
      const crypto = require('crypto');
      crypto.createDecipheriv.mockReturnValue({
        update: jest.fn().mockImplementation(() => {
          throw new Error('wrong final block length');
        }),
        final: jest.fn(),
        setAuthTag: jest.fn(),
      });

      await expect(
        manager.loadEncryptedKeypair('wrong-password', testFilePath)
      ).rejects.toThrow('Invalid password');

      expect(manager.isWalletUnlocked()).toBe(false);
    });

    it('should fail after max attempts', async () => {
      // Mock decryption failure
      const crypto = require('crypto');
      crypto.createDecipheriv.mockReturnValue({
        update: jest.fn().mockImplementation(() => {
          throw new Error('wrong final block length');
        }),
        final: jest.fn(),
        setAuthTag: jest.fn(),
      });

      // Make multiple failed attempts
      for (let i = 0; i < 3; i++) {
        try {
          await manager.loadEncryptedKeypair('wrong-password', testFilePath);
        } catch (error) {
          // Expected to fail
        }
      }

      // Next attempt should fail due to max attempts
      await expect(
        manager.loadEncryptedKeypair('wrong-password', testFilePath)
      ).rejects.toThrow('Maximum failed attempts exceeded');
    });
  });

  describe('validateTransactionSecurity', () => {
    let testTransaction: Transaction;

    beforeEach(() => {
      testTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: testKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        })
      );
    });

    it('should validate simple transaction as low risk', async () => {
      const result = await manager.validateTransactionSecurity(testTransaction);

      expect(result.isValid).toBe(true);
      expect(result.riskLevel).toBe('LOW');
      expect(result.shouldProceed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect complex transactions', async () => {
      // Add many instructions
      for (let i = 0; i < 15; i++) {
        testTransaction.add({
          keys: [],
          programId: SystemProgram.programId,
          data: Buffer.alloc(0),
        });
      }

      const result = await manager.validateTransactionSecurity(testTransaction);

      expect(result.riskLevel).toBe('MEDIUM');
      expect(result.warnings.some(w => w.includes('many instructions'))).toBe(true);
    });

    it('should detect unknown programs', async () => {
      testTransaction.add({
        keys: [],
        programId: new PublicKey('UnknownProgram1111111111111111111111111111'),
        data: Buffer.alloc(0),
      });

      const result = await manager.validateTransactionSecurity(testTransaction);

      expect(result.riskLevel).not.toBe('LOW');
      expect(result.warnings.some(w => w.includes('Unknown program'))).toBe(true);
    });

    it('should handle security validation errors', async () => {
      // Create invalid transaction to trigger error
      const invalidTransaction = {} as Transaction;

      const result = await manager.validateTransactionSecurity(invalidTransaction);

      expect(result.isValid).toBe(false);
      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.shouldProceed).toBe(false);
    });
  });

  describe('lock and unlock', () => {
    beforeEach(async () => {
      // Setup and load keypair
      const mockEncryptedKeypair = {
        encryptedSecretKey: 'base64EncryptedData',
        salt: 'base64Salt',
        iv: 'base64IV',
        algorithm: 'aes-256-gcm',
        iterations: 1000,
        publicKey: testKeypair.publicKey.toString(),
        metadata: {
          createdAt: Date.now(),
          keyRotations: 0,
        },
      };
      
      const fs = require('fs');
      fs.promises.readFile.mockResolvedValue(JSON.stringify(mockEncryptedKeypair));
      
      const crypto = require('crypto');
      crypto.createDecipheriv.mockReturnValue({
        update: jest.fn().mockReturnValue(Buffer.from(testKeypair.secretKey.slice(0, 32))),
        final: jest.fn().mockReturnValue(Buffer.from(testKeypair.secretKey.slice(32))),
        setAuthTag: jest.fn(),
      });

      await manager.loadEncryptedKeypair(testPassword, testFilePath);
    });

    it('should lock wallet', () => {
      expect(manager.isWalletUnlocked()).toBe(true);

      manager.lock();

      expect(manager.isWalletUnlocked()).toBe(false);
      expect(manager.getPublicKey()).toBeNull();
    });

    it('should auto-lock after timeout', (done) => {
      jest.useFakeTimers();
      
      expect(manager.isWalletUnlocked()).toBe(true);

      // Fast-forward time
      jest.advanceTimersByTime(150);

      setTimeout(() => {
        expect(manager.isWalletUnlocked()).toBe(false);
        jest.useRealTimers();
        done();
      }, 10);
    });
  });

  describe('getStats', () => {
    it('should return correct stats when locked', () => {
      const stats = manager.getStats();

      expect(stats.isUnlocked).toBe(false);
      expect(stats.lastUsed).toBeNull();
      expect(stats.failedAttempts).toBe(0);
      expect(stats.autoLockEnabled).toBe(true);
      expect(stats.publicKey).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const newConfig = {
        autoLockTimeoutMs: 5000,
        maxFailedAttempts: 5,
      };

      manager.updateConfig(newConfig);

      const stats = manager.getStats();
      expect(stats.autoLockEnabled).toBe(true);
    });

    it('should disable auto-lock when timeout is 0', () => {
      manager.updateConfig({ autoLockTimeoutMs: 0 });

      const stats = manager.getStats();
      expect(stats.autoLockEnabled).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      expect(manager.isWalletUnlocked()).toBe(false);

      manager.destroy();

      expect(manager.isWalletUnlocked()).toBe(false);
    });
  });
});