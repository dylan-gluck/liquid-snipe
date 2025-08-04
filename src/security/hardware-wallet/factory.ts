import {
  HardwareWalletFactory,
  HardwareWalletInterface,
  HardwareWalletInfo,
  HardwareWalletConfig,
} from './interface';
import { LedgerAdapter } from './ledger-adapter';
import { TrezorAdapter } from './trezor-adapter';
import { MockAdapter } from './mock-adapter';

/**
 * Hardware wallet types
 */
export enum HardwareWalletType {
  LEDGER = 'ledger',
  TREZOR = 'trezor',
  MOCK = 'mock',
}

/**
 * Hardware wallet detection result
 */
export interface DetectionResult {
  wallets: HardwareWalletInfo[];
  errors: Array<{
    type: HardwareWalletType;
    error: string;
  }>;
}

/**
 * Hardware wallet factory implementation
 */
export class HardwareWalletFactoryImpl implements HardwareWalletFactory {
  private config: HardwareWalletConfig;

  constructor(config: HardwareWalletConfig) {
    this.config = config;
  }

  async detectWallets(): Promise<HardwareWalletInfo[]> {
    const detection = await this.detectWalletsWithErrors();
    return detection.wallets;
  }

  /**
   * Detect wallets and return both results and errors
   */
  async detectWalletsWithErrors(): Promise<DetectionResult> {
    const wallets: HardwareWalletInfo[] = [];
    const errors: Array<{ type: HardwareWalletType; error: string }> = [];

    // Try to detect each wallet type
    const detectionPromises = [
      this.detectLedgerWallets(),
      this.detectTrezorWallets(),
      this.detectMockWallets(),
    ];

    const results = await Promise.allSettled(detectionPromises);

    results.forEach((result, index) => {
      const type = [HardwareWalletType.LEDGER, HardwareWalletType.TREZOR, HardwareWalletType.MOCK][index];
      
      if (result.status === 'fulfilled') {
        wallets.push(...result.value);
      } else {
        errors.push({
          type,
          error: result.reason?.message || 'Unknown detection error',
        });
      }
    });

    return { wallets, errors };
  }

  async createWallet(info: HardwareWalletInfo): Promise<HardwareWalletInterface> {
    switch (info.vendor.toLowerCase()) {
      case 'ledger':
        return new LedgerAdapter(info.path, {
          timeout: this.config.timeout,
          requireConfirmation: this.config.requireConfirmation,
          blindSigning: this.config.blindSigning,
        });

      case 'trezor':
        return new TrezorAdapter(info.path, {
          timeout: this.config.timeout,
          requireConfirmation: this.config.requireConfirmation,
          blindSigning: this.config.blindSigning,
        });

      case 'mock vendor':
        return new MockAdapter(info.id, {
          confirmationDelay: 1000,
          maxTransactionSize: 1232,
          firmwareVersion: '1.0.0-mock',
        });

      default:
        throw new Error(`Unsupported hardware wallet vendor: ${info.vendor}`);
    }
  }

  getSupportedTypes(): string[] {
    return Object.values(HardwareWalletType);
  }

  /**
   * Create a mock wallet for testing
   */
  createMockWallet(deviceId: string = 'test-mock'): MockAdapter {
    return new MockAdapter(deviceId, {
      confirmationDelay: 100, // Faster for testing
      maxTransactionSize: 1232,
      firmwareVersion: '1.0.0-test',
    });
  }

  /**
   * Get preferred wallet based on configuration
   */
  async getPreferredWallet(): Promise<HardwareWalletInterface | null> {
    const wallets = await this.detectWallets();
    
    if (wallets.length === 0) {
      return null;
    }

    // If a preferred vendor is specified, try to find it
    if (this.config.preferredVendor) {
      const preferred = wallets.find(
        wallet => wallet.vendor.toLowerCase() === this.config.preferredVendor
      );
      
      if (preferred) {
        return this.createWallet(preferred);
      }
    }

    // Otherwise, return the first available wallet
    return this.createWallet(wallets[0]);
  }

  private async detectLedgerWallets(): Promise<HardwareWalletInfo[]> {
    try {
      // In real implementation, this would use @ledgerhq/hw-transport-node-hid
      // to detect connected Ledger devices
      
      // For simulation, return mock Ledger devices if enabled
      if (process.env.NODE_ENV === 'test' || process.env.SIMULATE_HARDWARE_WALLETS) {
        return [
          {
            id: 'ledger-sim-1',
            name: 'Ledger Nano S Plus',
            model: 'Nano S Plus',
            vendor: 'Ledger',
            path: '/dev/hidraw0',
            connected: false,
          },
        ];
      }

      // Real implementation would look like:
      // const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid');
      // const devices = await TransportNodeHid.list();
      // return devices.map(device => ({
      //   id: `ledger-${device.path}`,
      //   name: device.productName || 'Ledger Device',
      //   model: device.productName || 'Unknown',
      //   vendor: 'Ledger',
      //   path: device.path,
      //   connected: false,
      // }));

      return [];
    } catch (error) {
      throw new Error(`Failed to detect Ledger wallets: ${error}`);
    }
  }

  private async detectTrezorWallets(): Promise<HardwareWalletInfo[]> {
    try {
      // In real implementation, this would use Trezor Connect or direct bridge communication
      
      // For simulation, return mock Trezor devices if enabled
      if (process.env.NODE_ENV === 'test' || process.env.SIMULATE_HARDWARE_WALLETS) {
        return [
          {
            id: 'trezor-sim-1',
            name: 'Trezor Model T',
            model: 'Model T',
            vendor: 'Trezor',
            path: 'bridge:1',
            connected: false,
          },
        ];
      }

      // Real implementation would look like:
      // const TrezorConnect = require('@trezor/connect');
      // await TrezorConnect.init({ ... });
      // const devices = await TrezorConnect.getFeatures();
      // return devices.map(device => ({ ... }));

      return [];
    } catch (error) {
      throw new Error(`Failed to detect Trezor wallets: ${error}`);
    }
  }

  private async detectMockWallets(): Promise<HardwareWalletInfo[]> {
    // Always return mock wallets for testing
    if (process.env.NODE_ENV === 'test' || process.env.ENABLE_MOCK_HARDWARE_WALLET) {
      return [
        {
          id: 'mock-wallet-1',
          name: 'Mock Hardware Wallet',
          model: 'Mock Model',
          vendor: 'Mock Vendor',
          path: '/mock/device',
          connected: false,
        },
      ];
    }

    return [];
  }
}

/**
 * Create a hardware wallet factory with default configuration
 */
export function createHardwareWalletFactory(
  config: Partial<HardwareWalletConfig> = {}
): HardwareWalletFactoryImpl {
  const defaultConfig: HardwareWalletConfig = {
    enabled: true,
    defaultDerivationPath: "m/44'/501'/0'/0'",
    timeout: 30000,
    requireConfirmation: true,
    blindSigning: false,
    autoConnect: true,
    reconnectAttempts: 3,
    reconnectDelay: 2000,
    ...config,
  };

  return new HardwareWalletFactoryImpl(defaultConfig);
}

/**
 * Utility function to get all available hardware wallet types
 */
export function getAvailableWalletTypes(): HardwareWalletType[] {
  return Object.values(HardwareWalletType);
}

/**
 * Check if a hardware wallet type is supported
 */
export function isWalletTypeSupported(type: string): boolean {
  return Object.values(HardwareWalletType).includes(type as HardwareWalletType);
}