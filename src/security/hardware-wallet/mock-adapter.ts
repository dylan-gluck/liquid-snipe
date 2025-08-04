import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  HardwareWalletInterface,
  HardwareWalletInfo,
  ConnectionStatus,
  HardwareCapabilities,
  HardwareAccount,
  HardwareSigningOptions,
  HardwareSigningResult,
  HardwareWalletError,
  HardwareWalletException,
} from './interface';

/**
 * Mock hardware wallet configuration
 */
export interface MockAdapterConfig {
  simulateUserRejection: boolean;
  simulateTimeout: boolean;
  simulateDeviceError: boolean;
  confirmationDelay: number;
  maxTransactionSize: number;
  firmwareVersion: string;
}

/**
 * Default mock configuration
 */
const DEFAULT_MOCK_CONFIG: MockAdapterConfig = {
  simulateUserRejection: false,
  simulateTimeout: false,
  simulateDeviceError: false,
  confirmationDelay: 1000,
  maxTransactionSize: 1232,
  firmwareVersion: '1.0.0-mock',
};

/**
 * Mock hardware wallet adapter for testing
 * 
 * This adapter uses real keypairs for signing but simulates the hardware wallet
 * interaction patterns, delays, and error conditions. Useful for testing
 * without requiring actual hardware devices.
 */
export class MockAdapter implements HardwareWalletInterface {
  private connected: boolean = false;
  private locked: boolean = false;
  private config: MockAdapterConfig;
  private deviceId: string;
  private keypairs: Map<string, Keypair> = new Map();
  private accounts: Map<number, HardwareAccount> = new Map();

  constructor(deviceId: string = 'mock-device', config: Partial<MockAdapterConfig> = {}) {
    this.deviceId = deviceId;
    this.config = { ...DEFAULT_MOCK_CONFIG, ...config };
  }

  async getInfo(): Promise<HardwareWalletInfo> {
    return {
      id: this.deviceId,
      name: 'Mock Hardware Wallet',
      model: 'Mock Model',
      vendor: 'Mock Vendor',
      path: `/mock/${this.deviceId}`,
      connected: this.connected,
    };
  }

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return {
      connected: this.connected,
      locked: this.locked,
      appOpen: this.connected && !this.locked,
      appName: this.connected ? 'Mock App' : undefined,
    };
  }

  async getCapabilities(): Promise<HardwareCapabilities> {
    return {
      supportsMultipleAccounts: true,
      supportsCustomDerivationPaths: true,
      supportsBlindSigning: true,
      supportsTransactionDisplay: true,
      maxTransactionSize: this.config.maxTransactionSize,
      supportedCurves: ['ed25519'],
    };
  }

  async connect(): Promise<void> {
    if (this.config.simulateDeviceError) {
      throw new HardwareWalletException(
        HardwareWalletError.COMMUNICATION_ERROR,
        'Simulated device connection error'
      );
    }

    await this.simulateDelay(500);
    this.connected = true;
    this.locked = false;
    
    // Generate some default keypairs
    await this.generateDefaultKeypairs();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.locked = true;
    this.keypairs.clear();
    this.accounts.clear();
  }

  async isConnected(): Promise<boolean> {
    return this.connected && !this.locked;
  }

  async getAccounts(startIndex: number = 0, count: number = 5): Promise<HardwareAccount[]> {
    await this.ensureConnected();

    const accounts: HardwareAccount[] = [];
    for (let i = startIndex; i < startIndex + count; i++) {
      const account = await this.getAccount(i);
      accounts.push(account);
    }

    return accounts;
  }

  async getAccount(index: number): Promise<HardwareAccount> {
    await this.ensureConnected();

    if (this.accounts.has(index)) {
      return this.accounts.get(index)!;
    }

    const derivationPath = `m/44'/501'/${index}'/0'`;
    const keypair = this.getOrCreateKeypair(derivationPath);

    const account: HardwareAccount = {
      index,
      derivationPath,
      publicKey: keypair.publicKey,
      address: keypair.publicKey.toBase58(),
    };

    this.accounts.set(index, account);
    return account;
  }

  async getPublicKey(derivationPath: string): Promise<PublicKey> {
    await this.ensureConnected();

    const keypair = this.getOrCreateKeypair(derivationPath);
    return keypair.publicKey;
  }

  async signTransaction(
    transaction: Transaction,
    derivationPath: string,
    options: Partial<HardwareSigningOptions> = {}
  ): Promise<HardwareSigningResult> {
    await this.ensureConnected();

    try {
      // Check transaction size
      const serialized = transaction.serialize({ requireAllSignatures: false });
      if (serialized.length > this.config.maxTransactionSize) {
        throw new HardwareWalletException(
          HardwareWalletError.TRANSACTION_TOO_LARGE,
          `Transaction size ${serialized.length} exceeds maximum ${this.config.maxTransactionSize}`
        );
      }

      // Simulate user interaction
      if (options.requireConfirmation !== false) {
        await this.simulateUserConfirmation(options.timeout);
      }

      // Get the keypair and sign
      const keypair = this.getOrCreateKeypair(derivationPath);
      transaction.partialSign(keypair);

      // Extract the signature
      const signature = transaction.signatures.find(sig => 
        sig.publicKey.equals(keypair.publicKey)
      );

      if (!signature?.signature) {
        throw new Error('Failed to extract signature');
      }

      return {
        success: true,
        signature: Buffer.from(signature.signature),
      };
    } catch (error) {
      if (error instanceof HardwareWalletException) {
        return {
          success: false,
          error: error.message,
          userRejected: error.errorType === HardwareWalletError.USER_REJECTED,
          timeout: error.errorType === HardwareWalletError.TIMEOUT,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown signing error',
      };
    }
  }

  async signTransactions(
    transactions: Transaction[],
    derivationPath: string,
    options: Partial<HardwareSigningOptions> = {}
  ): Promise<HardwareSigningResult[]> {
    const results: HardwareSigningResult[] = [];

    for (const transaction of transactions) {
      const result = await this.signTransaction(transaction, derivationPath, options);
      results.push(result);

      // If one transaction fails and it's not a user rejection, stop processing
      if (!result.success && !result.userRejected) {
        break;
      }
    }

    return results;
  }

  async verifyDevice(): Promise<boolean> {
    await this.ensureConnected();
    await this.simulateDelay(1000);
    return true; // Mock device is always "genuine"
  }

  async getFirmwareVersion(): Promise<string> {
    await this.ensureConnected();
    return this.config.firmwareVersion;
  }

  async needsFirmwareUpdate(): Promise<boolean> {
    return false; // Mock device never needs updates
  }

  /**
   * Set configuration for simulating specific behaviors
   */
  setConfig(config: Partial<MockAdapterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Lock the device for testing locked device scenarios
   */
  lock(): void {
    this.locked = true;
  }

  /**
   * Unlock the device
   */
  unlock(): void {
    this.locked = false;
  }

  /**
   * Force disconnect for testing disconnect scenarios
   */
  forceDisconnect(): void {
    this.connected = false;
    this.locked = true;
  }

  /**
   * Get the actual keypair for a derivation path (for testing purposes)
   */
  getKeypairForTesting(derivationPath: string): Keypair {
    return this.getOrCreateKeypair(derivationPath);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      throw new HardwareWalletException(
        HardwareWalletError.NOT_CONNECTED,
        'Mock device is not connected'
      );
    }

    if (this.locked) {
      throw new HardwareWalletException(
        HardwareWalletError.DEVICE_LOCKED,
        'Mock device is locked'
      );
    }
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async simulateUserConfirmation(timeout?: number): Promise<void> {
    if (this.config.simulateUserRejection) {
      throw new HardwareWalletException(
        HardwareWalletError.USER_REJECTED,
        'Simulated user rejection'
      );
    }

    if (this.config.simulateTimeout) {
      throw new HardwareWalletException(
        HardwareWalletError.TIMEOUT,
        'Simulated confirmation timeout'
      );
    }

    const confirmationTime = this.config.confirmationDelay;
    const timeoutMs = timeout || 30000;

    if (confirmationTime > timeoutMs) {
      throw new HardwareWalletException(
        HardwareWalletError.TIMEOUT,
        'User confirmation timeout'
      );
    }

    await this.simulateDelay(confirmationTime);
  }

  private getOrCreateKeypair(derivationPath: string): Keypair {
    if (this.keypairs.has(derivationPath)) {
      return this.keypairs.get(derivationPath)!;
    }

    // Generate a deterministic keypair based on derivation path and device ID
    const seed = this.generateSeed(derivationPath);
    const keypair = Keypair.fromSeed(seed);
    
    this.keypairs.set(derivationPath, keypair);
    return keypair;
  }

  private generateSeed(derivationPath: string): Uint8Array {
    // Generate a deterministic 32-byte seed based on device ID and derivation path
    const input = `${this.deviceId}:${derivationPath}`;
    const seed = new Uint8Array(32);
    
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) & 0xffffffff;
    }
    
    for (let i = 0; i < 32; i++) {
      seed[i] = (hash + i * 7) % 256;
      hash = (hash * 31) & 0xffffffff;
    }
    
    return seed;
  }

  private async generateDefaultKeypairs(): Promise<void> {
    // Pre-generate keypairs for the first few accounts
    for (let i = 0; i < 5; i++) {
      const derivationPath = `m/44'/501'/${i}'/0'`;
      this.getOrCreateKeypair(derivationPath);
    }
  }
}