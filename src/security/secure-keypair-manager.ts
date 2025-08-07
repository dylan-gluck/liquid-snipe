import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { Logger } from '../utils/logger';

/**
 * Represents an encrypted keypair stored on disk
 */
export interface EncryptedKeypair {
  encryptedSecretKey: string;
  salt: string;
  iv: string;
  algorithm: string;
  iterations: number;
  publicKey: string;
  metadata: {
    createdAt: number;
    lastUsed?: number;
    keyRotations: number;
  };
}

/**
 * Configuration for secure keypair management
 */
export interface SecureKeypairConfig {
  encryptionAlgorithm: string;
  keyDerivationIterations: number;
  saltLength: number;
  ivLength: number;
  requirePasswordConfirmation: boolean;
  autoLockTimeoutMs: number;
  maxFailedAttempts: number;
  keyRotationIntervalMs: number;
}

/**
 * Represents the result of a security validation check
 */
export interface SecurityValidationResult {
  isValid: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  warnings: string[];
  recommendations: string[];
  shouldProceed: boolean;
}

/**
 * Transaction signing options
 */
export interface SigningOptions {
  requireConfirmation?: boolean;
  validateSecurity?: boolean;
  maxValueUsd?: number;
  customValidation?: (transaction: Transaction) => Promise<boolean>;
}

/**
 * SecureKeypairManager provides comprehensive secure wallet management
 * with AES-256 encryption, password-based key derivation, and security validation.
 */
export class SecureKeypairManager {
  private keypair: Keypair | null = null;
  private logger: Logger;
  private config: SecureKeypairConfig;
  private isUnlocked: boolean = false;
  private failedAttempts: number = 0;
  private lastUsed: number | null = null;
  private autoLockTimer: NodeJS.Timeout | null = null;

  private readonly defaultConfig: SecureKeypairConfig = {
    encryptionAlgorithm: 'aes-256-gcm',
    keyDerivationIterations: 100000,
    saltLength: 32,
    ivLength: 12,
    requirePasswordConfirmation: false,
    autoLockTimeoutMs: 30 * 60 * 1000, // 30 minutes
    maxFailedAttempts: 3,
    keyRotationIntervalMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  };

  constructor(config?: Partial<SecureKeypairConfig>) {
    this.logger = new Logger('SecureKeypairManager');
    this.config = { ...this.defaultConfig, ...config };
  }

  /**
   * Generate a new keypair with secure entropy
   */
  public async generateKeypair(): Promise<Keypair> {
    try {
      this.logger.info('Generating new keypair with secure entropy');
      
      // Generate secure random bytes for enhanced entropy
      const entropy = randomBytes(32);
      const additionalEntropy = randomBytes(32);
      
      // Combine entropy sources
      const combinedEntropy = Buffer.concat([entropy, additionalEntropy]);
      const seed = createHash('sha256').update(combinedEntropy).digest();
      
      // Generate keypair from secure seed
      const keypair = Keypair.fromSeed(seed.slice(0, 32));
      
      this.logger.info('Keypair generated successfully', {
        publicKey: keypair.publicKey.toString(),
      });
      
      return keypair;
    } catch (error) {
      this.logger.error('Failed to generate keypair:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Keypair generation failed');
    }
  }

  /**
   * Encrypt and save a keypair to disk
   */
  public async saveEncryptedKeypair(
    keypair: Keypair,
    password: string,
    filePath: string
  ): Promise<void> {
    try {
      this.logger.info('Encrypting and saving keypair', { filePath });
      
      // Generate salt and IV
      const salt = randomBytes(this.config.saltLength);
      const iv = randomBytes(this.config.ivLength);
      
      // Derive encryption key from password
      const derivedKey = pbkdf2Sync(
        password,
        salt,
        this.config.keyDerivationIterations,
        32,
        'sha256'
      );
      
      // Encrypt the secret key
      const cipher = createCipheriv(this.config.encryptionAlgorithm, derivedKey, iv);
      const secretKeyBuffer = Buffer.from(keypair.secretKey);
      
      let encrypted = cipher.update(secretKeyBuffer);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      // Get authentication tag for AES-GCM
      const authTag = (cipher as any).getAuthTag();
      const encryptedWithTag = Buffer.concat([encrypted, authTag]);
      
      // Create encrypted keypair structure
      const encryptedKeypair: EncryptedKeypair = {
        encryptedSecretKey: encryptedWithTag.toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        algorithm: this.config.encryptionAlgorithm,
        iterations: this.config.keyDerivationIterations,
        publicKey: keypair.publicKey.toString(),
        metadata: {
          createdAt: Date.now(),
          keyRotations: 0,
        },
      };
      
      // Ensure directory exists
      const dir = dirname(filePath);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      
      // Save to file with secure permissions
      await fs.writeFile(filePath, JSON.stringify(encryptedKeypair, null, 2), {
        mode: 0o600, // Owner read/write only
      });
      
      this.logger.info('Keypair encrypted and saved successfully');
    } catch (error) {
      this.logger.error('Failed to save encrypted keypair:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to save encrypted keypair');
    }
  }

  /**
   * Load and decrypt a keypair from disk
   */
  public async loadEncryptedKeypair(
    password: string,
    filePath: string
  ): Promise<Keypair> {
    try {
      this.logger.info('Loading encrypted keypair', { filePath });
      
      // Check failed attempts
      if (this.failedAttempts >= this.config.maxFailedAttempts) {
        throw new Error('Maximum failed attempts exceeded. Wallet locked.');
      }
      
      // Read encrypted keypair file
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const encryptedKeypair: EncryptedKeypair = JSON.parse(fileContent);
      
      // Derive decryption key
      const salt = Buffer.from(encryptedKeypair.salt, 'base64');
      const derivedKey = pbkdf2Sync(
        password,
        salt,
        encryptedKeypair.iterations,
        32,
        'sha256'
      );
      
      // Decrypt the secret key
      const iv = Buffer.from(encryptedKeypair.iv, 'base64');
      const encryptedWithTag = Buffer.from(encryptedKeypair.encryptedSecretKey, 'base64');
      
      // Split encrypted data and auth tag for AES-GCM
      const encrypted = encryptedWithTag.slice(0, -16);
      const authTag = encryptedWithTag.slice(-16);
      
      const decipher = createDecipheriv(encryptedKeypair.algorithm, derivedKey, iv);
      (decipher as any).setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      // Create keypair from decrypted secret key
      const keypair = Keypair.fromSecretKey(new Uint8Array(decrypted));
      
      // Verify public key matches
      if (keypair.publicKey.toString() !== encryptedKeypair.publicKey) {
        throw new Error('Public key mismatch - potential tampering detected');
      }
      
      // Update metadata
      encryptedKeypair.metadata.lastUsed = Date.now();
      await fs.writeFile(filePath, JSON.stringify(encryptedKeypair, null, 2), {
        mode: 0o600,
      });
      
      // Reset failed attempts and set keypair
      this.failedAttempts = 0;
      this.keypair = keypair;
      this.isUnlocked = true;
      this.lastUsed = Date.now();
      this.startAutoLockTimer();
      
      this.logger.info('Keypair loaded and decrypted successfully');
      return keypair;
    } catch (error) {
      this.failedAttempts++;
      this.logger.error('Failed to load encrypted keypair:', {
        error: error instanceof Error ? error.message : String(error),
        failedAttempts: this.failedAttempts,
      });
      
      if (error instanceof Error && (error.message.includes('wrong final block length') || 
          error.message.includes('bad decrypt'))) {
        throw new Error('Invalid password');
      }
      
      throw error;
    }
  }

  /**
   * Sign a transaction with security validation
   */
  public async signTransaction(
    transaction: Transaction,
    options: SigningOptions = {}
  ): Promise<Transaction> {
    try {
      if (!this.isUnlocked || !this.keypair) {
        throw new Error('Keypair not loaded or wallet locked');
      }
      
      this.logger.debug('Signing transaction', {
        instructionCount: transaction.instructions.length,
        requireConfirmation: options.requireConfirmation,
        validateSecurity: options.validateSecurity,
      });
      
      // Validate security if requested
      if (options.validateSecurity) {
        const validation = await this.validateTransactionSecurity(transaction);
        if (!validation.shouldProceed) {
          throw new Error(`Transaction security validation failed: ${validation.warnings.join(', ')}`);
        }
        
        if (validation.riskLevel === 'HIGH' || validation.riskLevel === 'CRITICAL') {
          this.logger.warning('High-risk transaction detected', {
            riskLevel: validation.riskLevel,
            warnings: validation.warnings,
          });
        }
      }
      
      // Custom validation if provided
      if (options.customValidation) {
        const customValid = await options.customValidation(transaction);
        if (!customValid) {
          throw new Error('Custom validation failed');
        }
      }
      
      // Confirmation prompt for high-value transactions
      if (options.requireConfirmation || 
          (options.maxValueUsd && options.maxValueUsd > 1000)) {
        this.logger.info('Transaction requires confirmation', {
          maxValueUsd: options.maxValueUsd,
          instructionCount: transaction.instructions.length,
        });
        // In a real implementation, this would prompt the user
        // For now, we'll just log the requirement
      }
      
      // Sign the transaction
      transaction.sign(this.keypair);
      
      // Update last used timestamp
      this.lastUsed = Date.now();
      this.resetAutoLockTimer();
      
      this.logger.debug('Transaction signed successfully');
      return transaction;
    } catch (error) {
      this.logger.error('Failed to sign transaction:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate transaction security
   */
  public async validateTransactionSecurity(
    transaction: Transaction
  ): Promise<SecurityValidationResult> {
    try {
      const warnings: string[] = [];
      const recommendations: string[] = [];
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
      
      // Check transaction complexity
      if (transaction.instructions.length > 10) {
        warnings.push('Transaction has many instructions - may be complex or inefficient');
        riskLevel = 'MEDIUM';
      }
      
      // Check for known risky instruction patterns
      for (const instruction of transaction.instructions) {
        const programId = instruction.programId.toString();
        
        // Check for unknown programs
        const knownPrograms = [
          '11111111111111111111111111111111', // System Program
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
          '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
          '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca
          'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
        ];
        
        if (!knownPrograms.includes(programId)) {
          warnings.push(`Unknown program detected: ${programId}`);
          if (riskLevel === 'LOW') {
            riskLevel = 'MEDIUM';
          } else if (riskLevel === 'MEDIUM') {
            riskLevel = 'HIGH';
          }
        }
      }
      
      // Check transaction size
      const serialized = transaction.serialize({ requireAllSignatures: false });
      if (serialized.length > 1232) { // Max transaction size
        warnings.push('Transaction size near maximum limit');
        riskLevel = 'HIGH';
      }
      
      // Add general recommendations based on risk level
      if (riskLevel !== 'LOW') {
        recommendations.push('Consider reviewing transaction details carefully');
        recommendations.push('Use transaction simulation before execution');
      }
      
      if (riskLevel === 'HIGH') {
        recommendations.push('Consider using hardware wallet confirmation');
        recommendations.push('Split large transactions into smaller ones if possible');
      }
      
      const shouldProceed = riskLevel !== 'CRITICAL';
      
      this.logger.debug('Transaction security validation completed', {
        riskLevel,
        warningsCount: warnings.length,
        shouldProceed,
      });
      
      return {
        isValid: shouldProceed,
        riskLevel,
        warnings,
        recommendations,
        shouldProceed,
      };
    } catch (error) {
      this.logger.error('Transaction security validation failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      
      return {
        isValid: false,
        riskLevel: 'CRITICAL',
        warnings: ['Security validation failed'],
        recommendations: ['Do not proceed with transaction'],
        shouldProceed: false,
      };
    }
  }

  /**
   * Rotate keypair encryption (re-encrypt with new salt/IV)
   */
  public async rotateKeyEncryption(
    password: string,
    filePath: string
  ): Promise<void> {
    try {
      if (!this.keypair) {
        throw new Error('No keypair loaded for rotation');
      }
      
      this.logger.info('Rotating key encryption');
      
      // Save with new encryption parameters
      await this.saveEncryptedKeypair(this.keypair, password, filePath);
      
      // Update metadata to reflect rotation
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const encryptedKeypair: EncryptedKeypair = JSON.parse(fileContent);
      encryptedKeypair.metadata.keyRotations++;
      
      await fs.writeFile(filePath, JSON.stringify(encryptedKeypair, null, 2), {
        mode: 0o600,
      });
      
      this.logger.info('Key encryption rotated successfully');
    } catch (error) {
      this.logger.error('Failed to rotate key encryption:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Lock the wallet (clear keypair from memory)
   */
  public lock(): void {
    if (this.keypair) {
      // Clear keypair from memory
      this.keypair = null;
      this.isUnlocked = false;
      this.lastUsed = null;
      
      if (this.autoLockTimer) {
        clearTimeout(this.autoLockTimer);
        this.autoLockTimer = null;
      }
      
      this.logger.info('Wallet locked successfully');
    }
  }

  /**
   * Check if wallet is unlocked
   */
  public isWalletUnlocked(): boolean {
    return this.isUnlocked && this.keypair !== null;
  }

  /**
   * Get public key if wallet is unlocked
   */
  public getPublicKey(): PublicKey | null {
    return this.isUnlocked && this.keypair ? this.keypair.publicKey : null;
  }

  /**
   * Get wallet statistics
   */
  public getStats(): {
    isUnlocked: boolean;
    lastUsed: number | null;
    failedAttempts: number;
    autoLockEnabled: boolean;
    publicKey: string | null;
  } {
    return {
      isUnlocked: this.isUnlocked,
      lastUsed: this.lastUsed,
      failedAttempts: this.failedAttempts,
      autoLockEnabled: this.config.autoLockTimeoutMs > 0,
      publicKey: this.getPublicKey()?.toString() || null,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<SecureKeypairConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Configuration updated', { config });
    
    // Restart auto-lock timer if timeout changed
    if (config.autoLockTimeoutMs !== undefined && this.isUnlocked) {
      this.resetAutoLockTimer();
    }
  }

  /**
   * Start auto-lock timer
   */
  private startAutoLockTimer(): void {
    if (this.config.autoLockTimeoutMs > 0) {
      this.autoLockTimer = setTimeout(() => {
        this.logger.info('Auto-locking wallet due to inactivity');
        this.lock();
      }, this.config.autoLockTimeoutMs);
    }
  }

  /**
   * Reset auto-lock timer
   */
  private resetAutoLockTimer(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
    }
    this.startAutoLockTimer();
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    this.lock();
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
    }
    this.logger.info('SecureKeypairManager destroyed');
  }
}