import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EncryptedStorage,
  EncryptedStorageConfig,
  EncryptedContainer,
  StorageResult,
  IntegrityCheckResult
} from '../../src/security/encrypted-storage';

describe('EncryptedStorage', () => {
  let storage: EncryptedStorage;
  let testDir: string;
  let testFilePath: string;
  let config: EncryptedStorageConfig;

  const testPassword = 'test-storage-password-456!@#';
  const testData = {
    name: 'test-data',
    value: 12345,
    nested: {
      array: [1, 2, 3],
      boolean: true,
    },
  };

  beforeEach(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(join(tmpdir(), 'encrypted-storage-test-'));
    testFilePath = join(testDir, 'test-data.json');

    // Test configuration
    config = {
      encryptionAlgorithm: 'aes-256-gcm',
      keyDerivationIterations: 1000, // Reduced for faster tests
      saltLength: 32,
      ivLength: 12,
      hmacAlgorithm: 'sha256',
      compressionEnabled: false,
      backupEnabled: true,
      maxBackupCount: 3,
    };

    storage = new EncryptedStorage(config);
  });

  afterEach(async () => {
    try {
      await fs.rmdir(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('store', () => {
    it('should store encrypted data successfully', async () => {
      const result = await storage.store(testData, testPassword, testFilePath, 'test-data');

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(testFilePath);
      expect(result.error).toBeUndefined();

      // Check file exists and has correct permissions
      const stats = await fs.stat(testFilePath);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & parseInt('777', 8)).toBe(parseInt('600', 8));

      // Check file structure
      const content = await fs.readFile(testFilePath, 'utf-8');
      const container: EncryptedContainer = JSON.parse(content);

      expect(container.encryptedData).toBeDefined();
      expect(container.salt).toBeDefined();
      expect(container.iv).toBeDefined();
      expect(container.algorithm).toBe('aes-256-gcm');
      expect(container.hmac).toBeDefined();
      expect(container.metadata.dataType).toBe('test-data');
      expect(container.metadata.createdAt).toBeGreaterThan(0);
    });

    it('should create nested directories', async () => {
      const nestedPath = join(testDir, 'nested', 'deep', 'path', 'data.json');
      
      const result = await storage.store(testData, testPassword, nestedPath);
      
      expect(result.success).toBe(true);
      
      const stats = await fs.stat(nestedPath);
      expect(stats.isFile()).toBe(true);
    });

    it('should create backup of existing file', async () => {
      // Store initial data
      await storage.store(testData, testPassword, testFilePath);

      // Store again to trigger backup
      const updatedData = { ...testData, updated: true };
      const result = await storage.store(updatedData, testPassword, testFilePath);

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();

      // Check backup exists
      const backupStats = await fs.stat(result.backupPath!);
      expect(backupStats.isFile()).toBe(true);
    });

    it('should handle storage errors gracefully', async () => {
      const invalidPath = '/invalid/path/that/should/not/exist/data.json';
      
      const result = await storage.store(testData, testPassword, invalidPath);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should store different data types', async () => {
      const dataTypes = [
        { data: 'string data', type: 'string' },
        { data: 42, type: 'number' },
        { data: true, type: 'boolean' },
        { data: [1, 2, 3], type: 'array' },
        { data: null, type: 'null' },
      ];

      for (const { data, type } of dataTypes) {
        const filePath = join(testDir, `${type}.json`);
        const result = await storage.store(data, testPassword, filePath, type);
        
        expect(result.success).toBe(true);
        
        // Verify we can load it back
        const loaded = await storage.load(testPassword, filePath);
        expect(loaded).toEqual(data);
      }
    });
  });

  describe('load', () => {
    beforeEach(async () => {
      await storage.store(testData, testPassword, testFilePath, 'test-data');
    });

    it('should load and decrypt data successfully', async () => {
      const loadedData = await storage.load(testPassword, testFilePath);

      expect(loadedData).toEqual(testData);
    });

    it('should fail with incorrect password', async () => {
      await expect(
        storage.load('wrong-password', testFilePath)
      ).rejects.toThrow('Invalid password or corrupted data');
    });

    it('should verify HMAC integrity', async () => {
      // Tamper with the file
      const content = await fs.readFile(testFilePath, 'utf-8');
      const container: EncryptedContainer = JSON.parse(content);
      container.encryptedData = container.encryptedData.slice(0, -10) + 'tamperedxx';
      await fs.writeFile(testFilePath, JSON.stringify(container));

      await expect(
        storage.load(testPassword, testFilePath)
      ).rejects.toThrow('HMAC verification failed');
    });

    it('should handle missing file', async () => {
      const nonExistentPath = join(testDir, 'non-existent.json');

      await expect(
        storage.load(testPassword, nonExistentPath)
      ).rejects.toThrow();
    });

    it('should handle corrupted JSON', async () => {
      await fs.writeFile(testFilePath, 'invalid json data');

      await expect(
        storage.load(testPassword, testFilePath)
      ).rejects.toThrow();
    });

    it('should handle invalid container structure', async () => {
      const invalidContainer = { incomplete: 'data' };
      await fs.writeFile(testFilePath, JSON.stringify(invalidContainer));

      await expect(
        storage.load(testPassword, testFilePath)
      ).rejects.toThrow();
    });
  });

  describe('checkIntegrity', () => {
    beforeEach(async () => {
      await storage.store(testData, testPassword, testFilePath, 'test-data');
    });

    it('should pass integrity check for valid file', async () => {
      const result = await storage.checkIntegrity(testFilePath);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.fileSize).toBeGreaterThan(0);
      expect(result.lastModified).toBeGreaterThan(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should fail for non-existent file', async () => {
      const nonExistentPath = join(testDir, 'non-existent.json');
      
      const result = await storage.checkIntegrity(nonExistentPath);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('File does not exist');
      expect(result.fileSize).toBe(0);
    });

    it('should fail for empty file', async () => {
      await fs.writeFile(testFilePath, '');
      
      const result = await storage.checkIntegrity(testFilePath);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('File is empty');
    });

    it('should fail for invalid JSON', async () => {
      await fs.writeFile(testFilePath, 'invalid json');
      
      const result = await storage.checkIntegrity(testFilePath);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid JSON format');
    });

    it('should fail for missing required fields', async () => {
      const incompleteContainer = {
        encryptedData: 'data',
        salt: 'salt',
        // Missing other required fields
      };
      await fs.writeFile(testFilePath, JSON.stringify(incompleteContainer));
      
      const result = await storage.checkIntegrity(testFilePath);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing required field');
    });

    it('should warn about incorrect file permissions', async () => {
      // Change file permissions
      await fs.chmod(testFilePath, 0o644);
      
      const result = await storage.checkIntegrity(testFilePath);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.includes('File permissions'))).toBe(true);
    });
  });

  describe('backup management', () => {
    beforeEach(async () => {
      await storage.store(testData, testPassword, testFilePath, 'test-data');
    });

    it('should create backup successfully', async () => {
      const backupPath = await storage.createBackup(testFilePath);

      expect(backupPath).toContain('.backup.');
      
      const backupStats = await fs.stat(backupPath);
      expect(backupStats.isFile()).toBe(true);

      // Backup should have same content
      const originalContent = await fs.readFile(testFilePath, 'utf-8');
      const backupContent = await fs.readFile(backupPath, 'utf-8');
      expect(backupContent).toBe(originalContent);
    });

    it('should list backups correctly', async () => {
      // Create multiple backups
      const backup1 = await storage.createBackup(testFilePath);
      await new Promise(resolve => setTimeout(resolve, 10)); // Ensure different timestamps
      const backup2 = await storage.createBackup(testFilePath);

      const backups = await storage.listBackups(testFilePath);

      expect(backups).toHaveLength(2);
      expect(backups).toContain(backup1);
      expect(backups).toContain(backup2);
      expect(backups[0] < backups[1]).toBe(true); // Should be sorted
    });

    it('should restore from backup successfully', async () => {
      // Create backup
      const backupPath = await storage.createBackup(testFilePath);

      // Modify original file
      const modifiedData = { ...testData, modified: true };
      await storage.store(modifiedData, testPassword, testFilePath);

      // Restore from backup
      const result = await storage.restoreFromBackup(backupPath, testFilePath);

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(testFilePath);

      // Verify restored content
      const restoredData = await storage.load(testPassword, testFilePath);
      expect(restoredData).toEqual(testData);
      expect(restoredData).not.toEqual(modifiedData);
    });

    it('should clean up old backups', async () => {
      // Create more backups than maxBackupCount
      for (let i = 0; i < 5; i++) {
        await storage.store({ ...testData, version: i }, testPassword, testFilePath);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const backups = await storage.listBackups(testFilePath);
      expect(backups.length).toBeLessThanOrEqual(config.maxBackupCount);
    });

    it('should handle backup integrity check', async () => {
      // Create corrupted backup
      const backupPath = join(testDir, 'corrupted.backup');
      await fs.writeFile(backupPath, 'corrupted data');

      const result = await storage.restoreFromBackup(backupPath, testFilePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('integrity check failed');
    });
  });

  describe('configuration', () => {
    it('should use custom configuration', () => {
      const customConfig = {
        encryptionAlgorithm: 'aes-256-gcm',
        keyDerivationIterations: 50000,
        backupEnabled: false,
      };

      const customStorage = new EncryptedStorage(customConfig);
      const retrievedConfig = customStorage.getConfig();

      expect(retrievedConfig.keyDerivationIterations).toBe(50000);
      expect(retrievedConfig.backupEnabled).toBe(false);
    });

    it('should update configuration', () => {
      const newConfig = {
        maxBackupCount: 10,
        compressionEnabled: true,
      };

      storage.updateConfig(newConfig);
      const config = storage.getConfig();

      expect(config.maxBackupCount).toBe(10);
      expect(config.compressionEnabled).toBe(true);
    });

    it('should merge configuration with defaults', () => {
      const partialConfig = {
        maxBackupCount: 7,
      };

      const customStorage = new EncryptedStorage(partialConfig);
      const config = customStorage.getConfig();

      expect(config.maxBackupCount).toBe(7);
      expect(config.encryptionAlgorithm).toBe('aes-256-gcm'); // Default value
    });
  });

  describe('error handling', () => {
    it('should handle permission errors gracefully', async () => {
      // Try to store in a read-only location (this might not work on all systems)
      const readOnlyPath = '/root/readonly-file.json';
      
      const result = await storage.store(testData, testPassword, readOnlyPath);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle disk full scenarios', async () => {
      // This is hard to test reliably, but we can test with invalid paths
      const invalidPath = '\0invalid\0path';
      
      const result = await storage.store(testData, testPassword, invalidPath);
      
      expect(result.success).toBe(false);
    });

    it('should handle concurrent access', async () => {
      // Test multiple concurrent operations
      const promises = [];
      
      for (let i = 0; i < 5; i++) {
        const filePath = join(testDir, `concurrent-${i}.json`);
        promises.push(storage.store({ id: i, data: testData }, testPassword, filePath));
      }

      const results = await Promise.all(promises);
      
      // All operations should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('compression support', () => {
    it('should handle compression configuration', async () => {
      const compressedStorage = new EncryptedStorage({
        ...config,
        compressionEnabled: true,
      });

      // Store and load data with compression enabled
      const result = await compressedStorage.store(testData, testPassword, testFilePath);
      expect(result.success).toBe(true);

      const loadedData = await compressedStorage.load(testPassword, testFilePath);
      expect(loadedData).toEqual(testData);
    });
  });

  describe('large data handling', () => {
    it('should handle large data objects', async () => {
      // Create large test data
      const largeData = {
        largeArray: Array(10000).fill(0).map((_, i) => ({
          id: i,
          data: `test-data-${i}`,
          nested: { value: i * 2 },
        })),
      };

      const result = await storage.store(largeData, testPassword, testFilePath);
      expect(result.success).toBe(true);

      const loadedData = await storage.load(testPassword, testFilePath);
      expect(loadedData).toEqual(largeData);
    });
  });
});