import {
  HardwareWalletFactoryImpl,
  HardwareWalletType,
  createHardwareWalletFactory,
  getAvailableWalletTypes,
  isWalletTypeSupported,
} from '../../../src/security/hardware-wallet/factory';
import { HardwareWalletConfig, HardwareWalletInfo } from '../../../src/security/hardware-wallet/interface';
import { LedgerAdapter } from '../../../src/security/hardware-wallet/ledger-adapter';
import { TrezorAdapter } from '../../../src/security/hardware-wallet/trezor-adapter';
import { MockAdapter } from '../../../src/security/hardware-wallet/mock-adapter';

describe('HardwareWalletFactoryImpl', () => {
  let factory: HardwareWalletFactoryImpl;
  let config: HardwareWalletConfig;

  beforeEach(() => {
    config = {
      enabled: true,
      defaultDerivationPath: "m/44'/501'/0'/0'",
      timeout: 30000,
      requireConfirmation: true,
      blindSigning: false,
      autoConnect: true,
      reconnectAttempts: 3,
      reconnectDelay: 2000,
    };
    factory = new HardwareWalletFactoryImpl(config);
  });

  describe('Wallet Detection', () => {
    beforeEach(() => {
      // Set environment variable to enable simulation
      process.env.SIMULATE_HARDWARE_WALLETS = 'true';
    });

    afterEach(() => {
      delete process.env.SIMULATE_HARDWARE_WALLETS;
    });

    it('should detect wallets', async () => {
      const wallets = await factory.detectWallets();

      expect(wallets.length).toBeGreaterThan(0);
      wallets.forEach(wallet => {
        expect(wallet).toHaveProperty('id');
        expect(wallet).toHaveProperty('name');
        expect(wallet).toHaveProperty('model');
        expect(wallet).toHaveProperty('vendor');
        expect(wallet).toHaveProperty('path');
        expect(wallet).toHaveProperty('connected');
      });
    });

    it('should detect wallets with errors', async () => {
      const detection = await factory.detectWalletsWithErrors();

      expect(detection).toHaveProperty('wallets');
      expect(detection).toHaveProperty('errors');
      expect(Array.isArray(detection.wallets)).toBe(true);
      expect(Array.isArray(detection.errors)).toBe(true);
    });

    it('should detect Ledger wallets in simulation mode', async () => {
      const wallets = await factory.detectWallets();
      const ledgerWallets = wallets.filter(w => w.vendor === 'Ledger');

      expect(ledgerWallets.length).toBeGreaterThan(0);
      ledgerWallets.forEach(wallet => {
        expect(wallet.vendor).toBe('Ledger');
        expect(wallet.id).toContain('ledger');
      });
    });

    it('should detect Trezor wallets in simulation mode', async () => {
      const wallets = await factory.detectWallets();
      const trezorWallets = wallets.filter(w => w.vendor === 'Trezor');

      expect(trezorWallets.length).toBeGreaterThan(0);
      trezorWallets.forEach(wallet => {
        expect(wallet.vendor).toBe('Trezor');
        expect(wallet.id).toContain('trezor');
      });
    });

    it('should detect mock wallets', async () => {
      process.env.ENABLE_MOCK_HARDWARE_WALLET = 'true';
      
      const wallets = await factory.detectWallets();
      const mockWallets = wallets.filter(w => w.vendor === 'Mock Vendor');

      expect(mockWallets.length).toBeGreaterThan(0);
      mockWallets.forEach(wallet => {
        expect(wallet.vendor).toBe('Mock Vendor');
        expect(wallet.id).toContain('mock');
      });

      delete process.env.ENABLE_MOCK_HARDWARE_WALLET;
    });

    it('should return empty array when no simulation enabled', async () => {
      delete process.env.SIMULATE_HARDWARE_WALLETS;
      delete process.env.ENABLE_MOCK_HARDWARE_WALLET;
      process.env.NODE_ENV = 'production';

      const wallets = await factory.detectWallets();
      expect(wallets).toHaveLength(0);

      delete process.env.NODE_ENV;
    });
  });

  describe('Wallet Creation', () => {
    it('should create Ledger adapter', async () => {
      const info: HardwareWalletInfo = {
        id: 'ledger-test',
        name: 'Ledger Nano S Plus',
        model: 'Nano S Plus',
        vendor: 'Ledger',
        path: '/dev/hidraw0',
        connected: false,
      };

      const wallet = await factory.createWallet(info);

      expect(wallet).toBeInstanceOf(LedgerAdapter);
    });

    it('should create Trezor adapter', async () => {
      const info: HardwareWalletInfo = {
        id: 'trezor-test',
        name: 'Trezor Model T',
        model: 'Model T',
        vendor: 'Trezor',
        path: 'bridge:1',
        connected: false,
      };

      const wallet = await factory.createWallet(info);

      expect(wallet).toBeInstanceOf(TrezorAdapter);
    });

    it('should create Mock adapter', async () => {
      const info: HardwareWalletInfo = {
        id: 'mock-test',
        name: 'Mock Hardware Wallet',
        model: 'Mock Model',
        vendor: 'Mock Vendor',
        path: '/mock/device',
        connected: false,
      };

      const wallet = await factory.createWallet(info);

      expect(wallet).toBeInstanceOf(MockAdapter);
    });

    it('should throw error for unsupported vendor', async () => {
      const info: HardwareWalletInfo = {
        id: 'unknown-test',
        name: 'Unknown Wallet',
        model: 'Unknown Model',
        vendor: 'Unknown Vendor',
        path: '/unknown/device',
        connected: false,
      };

      await expect(factory.createWallet(info)).rejects.toThrow('Unsupported hardware wallet vendor');
    });

    it('should pass configuration to adapters', async () => {
      const customConfig: HardwareWalletConfig = {
        enabled: true,
        defaultDerivationPath: "m/44'/501'/0'/0'",
        timeout: 60000,
        requireConfirmation: false,
        blindSigning: true,
        autoConnect: true,
        reconnectAttempts: 5,
        reconnectDelay: 3000,
      };

      const customFactory = new HardwareWalletFactoryImpl(customConfig);

      const ledgerInfo: HardwareWalletInfo = {
        id: 'ledger-test',
        name: 'Ledger Nano S Plus',
        model: 'Nano S Plus',
        vendor: 'Ledger',
        path: '/dev/hidraw0',
        connected: false,
      };

      const wallet = await customFactory.createWallet(ledgerInfo) as LedgerAdapter;

      expect(wallet['config'].timeout).toBe(60000);
      expect(wallet['config'].requireConfirmation).toBe(false);
      expect(wallet['config'].blindSigning).toBe(true);
    });
  });

  describe('Supported Types', () => {
    it('should return supported wallet types', () => {
      const types = factory.getSupportedTypes();

      expect(types).toContain(HardwareWalletType.LEDGER);
      expect(types).toContain(HardwareWalletType.TREZOR);
      expect(types).toContain(HardwareWalletType.MOCK);
    });
  });

  describe('Mock Wallet Creation', () => {
    it('should create mock wallet with default ID', () => {
      const mockWallet = factory.createMockWallet();

      expect(mockWallet).toBeInstanceOf(MockAdapter);
      expect(mockWallet['deviceId']).toBe('test-mock');
    });

    it('should create mock wallet with custom ID', () => {
      const customId = 'custom-test-device';
      const mockWallet = factory.createMockWallet(customId);

      expect(mockWallet).toBeInstanceOf(MockAdapter);
      expect(mockWallet['deviceId']).toBe(customId);
    });

    it('should create mock wallet with optimized test configuration', () => {
      const mockWallet = factory.createMockWallet();

      expect(mockWallet['config'].confirmationDelay).toBe(100); // Faster for testing
      expect(mockWallet['config'].firmwareVersion).toBe('1.0.0-test');
    });
  });

  describe('Preferred Wallet Selection', () => {
    beforeEach(() => {
      process.env.SIMULATE_HARDWARE_WALLETS = 'true';
    });

    afterEach(() => {
      delete process.env.SIMULATE_HARDWARE_WALLETS;
    });

    it('should return null when no wallets detected', async () => {
      delete process.env.SIMULATE_HARDWARE_WALLETS;
      delete process.env.ENABLE_MOCK_HARDWARE_WALLET;

      const preferredWallet = await factory.getPreferredWallet();
      expect(preferredWallet).toBeNull();
    });

    it('should return preferred vendor when specified', async () => {
      const configWithPreference: HardwareWalletConfig = {
        ...config,
        preferredVendor: 'ledger',
      };
      const factoryWithPreference = new HardwareWalletFactoryImpl(configWithPreference);

      const preferredWallet = await factoryWithPreference.getPreferredWallet();

      expect(preferredWallet).not.toBeNull();
      expect(preferredWallet).toBeInstanceOf(LedgerAdapter);
    });

    it('should return first available wallet when no preference', async () => {
      const preferredWallet = await factory.getPreferredWallet();

      expect(preferredWallet).not.toBeNull();
      // Should be one of the supported adapter types
      expect(
        preferredWallet instanceof LedgerAdapter ||
        preferredWallet instanceof TrezorAdapter ||
        preferredWallet instanceof MockAdapter
      ).toBe(true);
    });

    it('should fallback to first available when preferred not found', async () => {
      const configWithInvalidPreference: HardwareWalletConfig = {
        ...config,
        preferredVendor: 'nonexistent' as any,
      };
      const factoryWithInvalidPreference = new HardwareWalletFactoryImpl(configWithInvalidPreference);

      const preferredWallet = await factoryWithInvalidPreference.getPreferredWallet();

      expect(preferredWallet).not.toBeNull();
      // Should fallback to first available
      expect(
        preferredWallet instanceof LedgerAdapter ||
        preferredWallet instanceof TrezorAdapter ||
        preferredWallet instanceof MockAdapter
      ).toBe(true);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle detection errors gracefully', async () => {
      // Mock the detection methods to throw errors
      jest.spyOn(factory as any, 'detectLedgerWallets').mockRejectedValue(new Error('Ledger detection failed'));
      jest.spyOn(factory as any, 'detectTrezorWallets').mockRejectedValue(new Error('Trezor detection failed'));
      jest.spyOn(factory as any, 'detectMockWallets').mockResolvedValue([]);

      const detection = await factory.detectWalletsWithErrors();

      expect(detection.wallets).toHaveLength(0);
      expect(detection.errors).toHaveLength(2);
      expect(detection.errors[0].type).toBe(HardwareWalletType.LEDGER);
      expect(detection.errors[1].type).toBe(HardwareWalletType.TREZOR);
    });

    it('should continue detection when one type fails', async () => {
      // Mock only Ledger to fail
      jest.spyOn(factory as any, 'detectLedgerWallets').mockRejectedValue(new Error('Ledger detection failed'));
      
      process.env.SIMULATE_HARDWARE_WALLETS = 'true';

      const detection = await factory.detectWalletsWithErrors();

      expect(detection.wallets.length).toBeGreaterThan(0); // Should have Trezor wallets
      expect(detection.errors).toHaveLength(1);
      expect(detection.errors[0].type).toBe(HardwareWalletType.LEDGER);
    });
  });
});

describe('Factory Utility Functions', () => {
  describe('createHardwareWalletFactory', () => {
    it('should create factory with default configuration', () => {
      const factory = createHardwareWalletFactory();

      expect(factory).toBeInstanceOf(HardwareWalletFactoryImpl);
      expect(factory['config'].enabled).toBe(true);
      expect(factory['config'].timeout).toBe(30000);
    });

    it('should create factory with custom configuration', () => {
      const customConfig = {
        timeout: 60000,
        requireConfirmation: false,
        preferredVendor: 'trezor' as const,
      };

      const factory = createHardwareWalletFactory(customConfig);

      expect(factory).toBeInstanceOf(HardwareWalletFactoryImpl);
      expect(factory['config'].timeout).toBe(60000);
      expect(factory['config'].requireConfirmation).toBe(false);
      expect(factory['config'].preferredVendor).toBe('trezor');
      expect(factory['config'].enabled).toBe(true); // Default value
    });
  });

  describe('getAvailableWalletTypes', () => {
    it('should return all wallet types', () => {
      const types = getAvailableWalletTypes();

      expect(types).toContain(HardwareWalletType.LEDGER);
      expect(types).toContain(HardwareWalletType.TREZOR);
      expect(types).toContain(HardwareWalletType.MOCK);
      expect(types).toHaveLength(3);
    });
  });

  describe('isWalletTypeSupported', () => {
    it('should return true for supported types', () => {
      expect(isWalletTypeSupported('ledger')).toBe(true);
      expect(isWalletTypeSupported('trezor')).toBe(true);
      expect(isWalletTypeSupported('mock')).toBe(true);
    });

    it('should return false for unsupported types', () => {
      expect(isWalletTypeSupported('unknown')).toBe(false);
      expect(isWalletTypeSupported('keepkey')).toBe(false);
      expect(isWalletTypeSupported('')).toBe(false);
    });

    it('should be case sensitive', () => {
      expect(isWalletTypeSupported('LEDGER')).toBe(false);
      expect(isWalletTypeSupported('Trezor')).toBe(false);
      expect(isWalletTypeSupported('Mock')).toBe(false);
    });
  });
});

describe('HardwareWalletType enum', () => {
  it('should have correct values', () => {
    expect(HardwareWalletType.LEDGER).toBe('ledger');
    expect(HardwareWalletType.TREZOR).toBe('trezor');
    expect(HardwareWalletType.MOCK).toBe('mock');
  });

  it('should have unique values', () => {
    const values = Object.values(HardwareWalletType);
    const uniqueValues = [...new Set(values)];
    
    expect(values.length).toBe(uniqueValues.length);
  });
});