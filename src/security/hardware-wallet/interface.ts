import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

/**
 * Hardware wallet device information
 */
export interface HardwareWalletInfo {
  id: string;
  name: string;
  model: string;
  vendor: string;
  path: string;
  connected: boolean;
}

/**
 * Hardware wallet connection status
 */
export interface ConnectionStatus {
  connected: boolean;
  locked: boolean;
  error?: string;
  appOpen?: boolean;
  appName?: string;
}

/**
 * Transaction signing options
 */
export interface HardwareSigningOptions {
  requireConfirmation?: boolean;
  displayTransaction?: boolean;
  blindSigning?: boolean;
  timeout?: number;
}

/**
 * Hardware wallet signing result
 */
export interface HardwareSigningResult {
  success: boolean;
  signature?: Buffer;
  error?: string;
  userRejected?: boolean;
  timeout?: boolean;
}

/**
 * Hardware wallet capabilities
 */
export interface HardwareCapabilities {
  supportsMultipleAccounts: boolean;
  supportsCustomDerivationPaths: boolean;
  supportsBlindSigning: boolean;
  supportsTransactionDisplay: boolean;
  maxTransactionSize: number;
  supportedCurves: string[];
}

/**
 * Hardware wallet account information
 */
export interface HardwareAccount {
  index: number;
  derivationPath: string;
  publicKey: PublicKey;
  address: string;
}

/**
 * Common interface for all hardware wallet implementations
 */
export interface HardwareWalletInterface {
  /**
   * Get wallet information
   */
  getInfo(): Promise<HardwareWalletInfo>;

  /**
   * Check connection status
   */
  getConnectionStatus(): Promise<ConnectionStatus>;

  /**
   * Get wallet capabilities
   */
  getCapabilities(): Promise<HardwareCapabilities>;

  /**
   * Connect to the hardware wallet
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the hardware wallet
   */
  disconnect(): Promise<void>;

  /**
   * Check if the wallet is connected and ready
   */
  isConnected(): Promise<boolean>;

  /**
   * Get accounts from the hardware wallet
   * @param startIndex Starting account index
   * @param count Number of accounts to retrieve
   */
  getAccounts(startIndex?: number, count?: number): Promise<HardwareAccount[]>;

  /**
   * Get a specific account by index
   * @param index Account index
   */
  getAccount(index: number): Promise<HardwareAccount>;

  /**
   * Get the public key for a specific account
   * @param derivationPath BIP44 derivation path
   */
  getPublicKey(derivationPath: string): Promise<PublicKey>;

  /**
   * Sign a transaction with the hardware wallet
   * @param transaction Transaction to sign
   * @param derivationPath Derivation path for the signing key
   * @param options Signing options
   */
  signTransaction(
    transaction: Transaction,
    derivationPath: string,
    options?: Partial<HardwareSigningOptions>
  ): Promise<HardwareSigningResult>;

  /**
   * Sign multiple transactions
   * @param transactions Transactions to sign
   * @param derivationPath Derivation path for the signing key
   * @param options Signing options
   */
  signTransactions(
    transactions: Transaction[],
    derivationPath: string,
    options?: Partial<HardwareSigningOptions>
  ): Promise<HardwareSigningResult[]>;

  /**
   * Verify that the device is genuine and not compromised
   */
  verifyDevice(): Promise<boolean>;

  /**
   * Get device firmware version
   */
  getFirmwareVersion(): Promise<string>;

  /**
   * Check if device needs firmware update
   */
  needsFirmwareUpdate(): Promise<boolean>;
}

/**
 * Hardware wallet factory interface
 */
export interface HardwareWalletFactory {
  /**
   * Detect available hardware wallets
   */
  detectWallets(): Promise<HardwareWalletInfo[]>;

  /**
   * Create a hardware wallet instance
   */
  createWallet(info: HardwareWalletInfo): Promise<HardwareWalletInterface>;

  /**
   * Get supported wallet types
   */
  getSupportedTypes(): string[];
}

/**
 * Hardware wallet configuration
 */
export interface HardwareWalletConfig {
  enabled: boolean;
  preferredVendor?: 'ledger' | 'trezor';
  defaultDerivationPath: string;
  timeout: number;
  requireConfirmation: boolean;
  blindSigning: boolean;
  autoConnect: boolean;
  reconnectAttempts: number;
  reconnectDelay: number;
}

/**
 * Default hardware wallet configuration
 */
export const DEFAULT_HARDWARE_WALLET_CONFIG: HardwareWalletConfig = {
  enabled: false,
  defaultDerivationPath: "m/44'/501'/0'/0'",
  timeout: 30000,
  requireConfirmation: true,
  blindSigning: false,
  autoConnect: true,
  reconnectAttempts: 3,
  reconnectDelay: 2000,
};

/**
 * Hardware wallet error types
 */
export enum HardwareWalletError {
  NOT_CONNECTED = 'NOT_CONNECTED',
  DEVICE_LOCKED = 'DEVICE_LOCKED',
  APP_NOT_OPEN = 'APP_NOT_OPEN',
  USER_REJECTED = 'USER_REJECTED',
  TIMEOUT = 'TIMEOUT',
  FIRMWARE_OUTDATED = 'FIRMWARE_OUTDATED',
  DEVICE_NOT_GENUINE = 'DEVICE_NOT_GENUINE',
  TRANSACTION_TOO_LARGE = 'TRANSACTION_TOO_LARGE',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  COMMUNICATION_ERROR = 'COMMUNICATION_ERROR',
}

/**
 * Hardware wallet exception
 */
export class HardwareWalletException extends Error {
  constructor(
    public readonly errorType: HardwareWalletError,
    message: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'HardwareWalletException';
  }
}