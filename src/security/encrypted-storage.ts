import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash, createHmac } from 'crypto';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Logger } from '../utils/logger';

/**
 * Represents an encrypted data container
 */
export interface EncryptedContainer {
  encryptedData: string;
  salt: string;
  iv: string;
  algorithm: string;
  iterations: number;
  hmac: string;
  metadata: {
    createdAt: number;
    lastModified: number;
    dataType: string;
    version: string;
  };
}

/**
 * Configuration for encrypted storage
 */
export interface EncryptedStorageConfig {
  encryptionAlgorithm: string;
  keyDerivationIterations: number;
  saltLength: number;
  ivLength: number;
  hmacAlgorithm: string;
  compressionEnabled: boolean;
  backupEnabled: boolean;
  maxBackupCount: number;
}

/**
 * Storage operation result
 */
export interface StorageResult {
  success: boolean;
  error?: string;
  filePath?: string;
  backupPath?: string;
}

/**
 * File integrity check result
 */
export interface IntegrityCheckResult {
  isValid: boolean;
  error?: string;
  warnings: string[];
  fileSize: number;
  lastModified: number;
}

/**
 * EncryptedStorage provides secure file storage with encryption,
 * integrity verification, and backup capabilities.
 */
export class EncryptedStorage {
  private logger: Logger;
  private config: EncryptedStorageConfig;

  private readonly defaultConfig: EncryptedStorageConfig = {
    encryptionAlgorithm: 'aes-256-gcm',
    keyDerivationIterations: 100000,
    saltLength: 32,
    ivLength: 12,
    hmacAlgorithm: 'sha256',
    compressionEnabled: false,
    backupEnabled: true,
    maxBackupCount: 5,
  };

  constructor(config?: Partial<EncryptedStorageConfig>) {
    this.logger = new Logger('EncryptedStorage');
    this.config = { ...this.defaultConfig, ...config };
  }

  /**
   * Store encrypted data to file
   */
  public async store(
    data: any,
    password: string,
    filePath: string,
    dataType: string = 'generic'
  ): Promise<StorageResult> {
    try {
      this.logger.debug('Storing encrypted data', { filePath, dataType });

      // Ensure directory exists
      await this.ensureDirectory(dirname(filePath));

      // Create backup if file exists and backup is enabled
      let backupPath: string | undefined;
      if (this.config.backupEnabled && await this.fileExists(filePath)) {
        backupPath = await this.createBackup(filePath);
      }

      // Serialize data
      const serializedData = JSON.stringify(data);
      let dataBuffer = Buffer.from(serializedData, 'utf-8');

      // Compress if enabled
      if (this.config.compressionEnabled) {
        dataBuffer = Buffer.from(await this.compressData(dataBuffer));
      }

      // Generate salt and IV
      const salt = randomBytes(this.config.saltLength);
      const iv = randomBytes(this.config.ivLength);

      // Derive encryption key
      const derivedKey = pbkdf2Sync(
        password,
        salt,
        this.config.keyDerivationIterations,
        32,
        'sha256'
      );

      // Encrypt data
      const cipher = createCipheriv(this.config.encryptionAlgorithm, derivedKey, iv);
      let encrypted = cipher.update(dataBuffer);
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      // Get authentication tag for AES-GCM
      const authTag = (cipher as any).getAuthTag();
      const encryptedWithTag = Buffer.concat([encrypted, authTag]);

      // Create HMAC for additional integrity verification
      const hmacKey = pbkdf2Sync(password + 'hmac', salt, 10000, 32, 'sha256');
      const hmac = createHmac(this.config.hmacAlgorithm, hmacKey);
      hmac.update(encryptedWithTag);
      const hmacDigest = hmac.digest('base64');

      // Create encrypted container
      const container: EncryptedContainer = {
        encryptedData: encryptedWithTag.toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        algorithm: this.config.encryptionAlgorithm,
        iterations: this.config.keyDerivationIterations,
        hmac: hmacDigest,
        metadata: {
          createdAt: Date.now(),
          lastModified: Date.now(),
          dataType,
          version: '1.0',
        },
      };

      // Write to file with secure permissions
      await fs.writeFile(filePath, JSON.stringify(container, null, 2), {
        mode: 0o600, // Owner read/write only
      });

      this.logger.info('Data stored successfully', { filePath, dataType });

      // Clean up old backups
      if (backupPath) {
        await this.cleanupOldBackups(filePath);
      }

      return {
        success: true,
        filePath,
        backupPath,
      };
    } catch (error) {
      this.logger.error('Failed to store encrypted data:', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Load and decrypt data from file
   */
  public async load<T = any>(
    password: string,
    filePath: string
  ): Promise<T> {
    try {
      this.logger.debug('Loading encrypted data', { filePath });

      // Check file integrity first
      const integrityCheck = await this.checkIntegrity(filePath);
      if (!integrityCheck.isValid) {
        throw new Error(`File integrity check failed: ${integrityCheck.error}`);
      }

      // Read encrypted container
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const container: EncryptedContainer = JSON.parse(fileContent);

      // Derive decryption key
      const salt = Buffer.from(container.salt, 'base64');
      const derivedKey = pbkdf2Sync(
        password,
        salt,
        container.iterations,
        32,
        'sha256'
      );

      // Verify HMAC
      const hmacKey = pbkdf2Sync(password + 'hmac', salt, 10000, 32, 'sha256');
      const hmac = createHmac(this.config.hmacAlgorithm, hmacKey);
      const encryptedWithTag = Buffer.from(container.encryptedData, 'base64');
      hmac.update(encryptedWithTag);
      const expectedHmac = hmac.digest('base64');

      if (expectedHmac !== container.hmac) {
        throw new Error('HMAC verification failed - data may have been tampered with');
      }

      // Decrypt data
      const iv = Buffer.from(container.iv, 'base64');
      const encrypted = encryptedWithTag.slice(0, -16);
      const authTag = encryptedWithTag.slice(-16);

      const decipher = createDecipheriv(container.algorithm, derivedKey, iv);
      (decipher as any).setAuthTag(authTag);

      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      // Decompress if needed
      if (this.config.compressionEnabled) {
        decrypted = Buffer.from(await this.decompressData(decrypted));
      }

      // Parse data
      const serializedData = decrypted.toString('utf-8');
      const data = JSON.parse(serializedData);

      this.logger.debug('Data loaded successfully', { 
        filePath,
        dataType: container.metadata.dataType,
      });

      return data;
    } catch (error) {
      this.logger.error('Failed to load encrypted data:', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });

      if (error instanceof Error && (error.message.includes('wrong final block length') ||
          error.message.includes('bad decrypt'))) {
        throw new Error('Invalid password or corrupted data');
      }

      throw error;
    }
  }

  /**
   * Check file integrity
   */
  public async checkIntegrity(filePath: string): Promise<IntegrityCheckResult> {
    try {
      const warnings: string[] = [];

      // Check if file exists
      if (!await this.fileExists(filePath)) {
        return {
          isValid: false,
          error: 'File does not exist',
          warnings: [],
          fileSize: 0,
          lastModified: 0,
        };
      }

      // Get file stats
      const stats = await fs.stat(filePath);
      
      // Check file permissions
      const mode = stats.mode & parseInt('777', 8);
      if (mode !== parseInt('600', 8)) {
        warnings.push(`File permissions are ${mode.toString(8)}, should be 600`);
      }

      // Check file size
      if (stats.size === 0) {
        return {
          isValid: false,
          error: 'File is empty',
          warnings,
          fileSize: stats.size,
          lastModified: stats.mtime.getTime(),
        };
      }

      // Try to parse as JSON
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const container: EncryptedContainer = JSON.parse(content);

        // Validate container structure
        const requiredFields = ['encryptedData', 'salt', 'iv', 'algorithm', 'hmac', 'metadata'];
        for (const field of requiredFields) {
          if (!(field in container)) {
            return {
              isValid: false,
              error: `Missing required field: ${field}`,
              warnings,
              fileSize: stats.size,
              lastModified: stats.mtime.getTime(),
            };
          }
        }

        // Check for suspicious modifications
        const timeDiff = Date.now() - container.metadata.lastModified;
        if (timeDiff < 0) {
          warnings.push('File modification time is in the future');
        }

      } catch (parseError) {
        return {
          isValid: false,
          error: 'Invalid JSON format',
          warnings,
          fileSize: stats.size,
          lastModified: stats.mtime.getTime(),
        };
      }

      return {
        isValid: true,
        warnings,
        fileSize: stats.size,
        lastModified: stats.mtime.getTime(),
      };
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
        fileSize: 0,
        lastModified: 0,
      };
    }
  }

  /**
   * Create backup of existing file
   */
  public async createBackup(filePath: string): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filePath}.backup.${timestamp}`;

      await fs.copyFile(filePath, backupPath);
      
      this.logger.debug('Backup created', { filePath, backupPath });
      return backupPath;
    } catch (error) {
      this.logger.error('Failed to create backup:', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw error;
    }
  }

  /**
   * List available backups for a file
   */
  public async listBackups(filePath: string): Promise<string[]> {
    try {
      const dir = dirname(filePath);
      const baseName = filePath.split('/').pop() || '';
      const files = await fs.readdir(dir);
      
      const backups = files
        .filter(file => file.startsWith(`${baseName}.backup.`))
        .map(file => `${dir}/${file}`)
        .sort();
      
      return backups;
    } catch (error) {
      this.logger.error('Failed to list backups:', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      return [];
    }
  }

  /**
   * Restore from backup
   */
  public async restoreFromBackup(
    backupPath: string,
    targetPath: string
  ): Promise<StorageResult> {
    try {
      // Verify backup integrity
      const integrityCheck = await this.checkIntegrity(backupPath);
      if (!integrityCheck.isValid) {
        return {
          success: false,
          error: `Backup integrity check failed: ${integrityCheck.error}`,
        };
      }

      // Create backup of current file if it exists
      let currentBackupPath: string | undefined;
      if (await this.fileExists(targetPath)) {
        currentBackupPath = await this.createBackup(targetPath);
      }

      // Copy backup to target location
      await fs.copyFile(backupPath, targetPath);

      this.logger.info('Restored from backup', { backupPath, targetPath });

      return {
        success: true,
        filePath: targetPath,
        backupPath: currentBackupPath,
      };
    } catch (error) {
      this.logger.error('Failed to restore from backup:', {
        error: error instanceof Error ? error.message : String(error),
        backupPath,
        targetPath,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Clean up old backups, keeping only the most recent ones
   */
  private async cleanupOldBackups(filePath: string): Promise<void> {
    try {
      const backups = await this.listBackups(filePath);
      
      if (backups.length > this.config.maxBackupCount) {
        const toDelete = backups.slice(0, backups.length - this.config.maxBackupCount);
        
        for (const backup of toDelete) {
          await fs.unlink(backup);
          this.logger.debug('Deleted old backup', { backup });
        }
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old backups:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as any).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Compress data (placeholder for future implementation)
   */
  private async compressData(data: Buffer): Promise<Buffer> {
    // For now, return data as-is
    // In the future, could implement compression using zlib
    return data;
  }

  /**
   * Decompress data (placeholder for future implementation)
   */
  private async decompressData(data: Buffer): Promise<Buffer> {
    // For now, return data as-is
    // In the future, could implement decompression using zlib
    return data;
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<EncryptedStorageConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Configuration updated', { config });
  }

  /**
   * Get configuration
   */
  public getConfig(): EncryptedStorageConfig {
    return { ...this.config };
  }
}