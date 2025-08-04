import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { MockAdapter } from '../../../src/security/hardware-wallet/mock-adapter';
import { HardwareWalletError, HardwareWalletException } from '../../../src/security/hardware-wallet/interface';

describe('MockAdapter', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter('test-device');
  });

  afterEach(async () => {
    if (await adapter.isConnected()) {
      await adapter.disconnect();
    }
  });

  describe('Device Information', () => {
    it('should return correct device info', async () => {
      const info = await adapter.getInfo();

      expect(info).toEqual({
        id: 'test-device',
        name: 'Mock Hardware Wallet',
        model: 'Mock Model',
        vendor: 'Mock Vendor',
        path: '/mock/test-device',
        connected: false,
      });
    });

    it('should return connection status', async () => {
      let status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(false);
      expect(status.locked).toBe(false);

      await adapter.connect();
      status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(true);
      expect(status.appOpen).toBe(true);
      expect(status.appName).toBe('Mock App');
    });

    it('should return capabilities', async () => {
      const capabilities = await adapter.getCapabilities();

      expect(capabilities).toEqual({
        supportsMultipleAccounts: true,
        supportsCustomDerivationPaths: true,
        supportsBlindSigning: true,
        supportsTransactionDisplay: true,
        maxTransactionSize: 1232,
        supportedCurves: ['ed25519'],
      });
    });
  });

  describe('Connection Management', () => {
    it('should connect successfully', async () => {
      expect(await adapter.isConnected()).toBe(false);

      await adapter.connect();

      expect(await adapter.isConnected()).toBe(true);
      const status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(true);
      expect(status.locked).toBe(false);
    });

    it('should disconnect successfully', async () => {
      await adapter.connect();
      expect(await adapter.isConnected()).toBe(true);

      await adapter.disconnect();

      expect(await adapter.isConnected()).toBe(false);
      const status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(false);
      expect(status.locked).toBe(true);
    });

    it('should handle multiple connect calls gracefully', async () => {
      await adapter.connect();
      await adapter.connect(); // Should not throw

      expect(await adapter.isConnected()).toBe(true);
    });

    it('should handle multiple disconnect calls gracefully', async () => {
      await adapter.connect();
      await adapter.disconnect();
      await adapter.disconnect(); // Should not throw

      expect(await adapter.isConnected()).toBe(false);
    });

    it('should simulate device error during connection', async () => {
      adapter.setConfig({ simulateDeviceError: true });

      await expect(adapter.connect()).rejects.toThrow(HardwareWalletException);
      await expect(adapter.connect()).rejects.toThrow('Simulated device connection error');
    });
  });

  describe('Account Management', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should get single account', async () => {
      const account = await adapter.getAccount(0);

      expect(account.index).toBe(0);
      expect(account.derivationPath).toBe("m/44'/501'/0'/0'");
      expect(account.publicKey).toBeInstanceOf(PublicKey);
      expect(account.address).toBe(account.publicKey.toBase58());
    });

    it('should get multiple accounts', async () => {
      const accounts = await adapter.getAccounts(0, 3);

      expect(accounts).toHaveLength(3);
      accounts.forEach((account, index) => {
        expect(account.index).toBe(index);
        expect(account.derivationPath).toBe(`m/44'/501'/${index}'/0'`);
        expect(account.publicKey).toBeInstanceOf(PublicKey);
      });
    });

    it('should get accounts with custom start index', async () => {
      const accounts = await adapter.getAccounts(5, 2);

      expect(accounts).toHaveLength(2);
      expect(accounts[0].index).toBe(5);
      expect(accounts[1].index).toBe(6);
    });

    it('should cache accounts for repeated requests', async () => {
      const account1 = await adapter.getAccount(0);
      const account2 = await adapter.getAccount(0);

      expect(account1).toBe(account2); // Same reference
    });

    it('should get public key for custom derivation path', async () => {
      const customPath = "m/44'/501'/10'/0'";
      const publicKey = await adapter.getPublicKey(customPath);

      expect(publicKey).toBeInstanceOf(PublicKey);
    });

    it('should generate different keys for different derivation paths', async () => {
      const key1 = await adapter.getPublicKey("m/44'/501'/0'/0'");
      const key2 = await adapter.getPublicKey("m/44'/501'/1'/0'");

      expect(key1.equals(key2)).toBe(false);
    });

    it('should generate same key for same derivation path', async () => {
      const key1 = await adapter.getPublicKey("m/44'/501'/0'/0'");
      const key2 = await adapter.getPublicKey("m/44'/501'/0'/0'");

      expect(key1.equals(key2)).toBe(true);
    });

    it('should throw when not connected', async () => {
      await adapter.disconnect();

      await expect(adapter.getAccount(0)).rejects.toThrow(HardwareWalletException);
      await expect(adapter.getAccount(0)).rejects.toThrow('Mock device is not connected');
    });

    it('should throw when device is locked', async () => {
      adapter.lock();

      await expect(adapter.getAccount(0)).rejects.toThrow(HardwareWalletException);
      await expect(adapter.getAccount(0)).rejects.toThrow('Mock device is locked');
    });
  });

  describe('Transaction Signing', () => {
    let transaction: Transaction;
    let fromKeypair: Keypair;
    let toKeypair: Keypair;

    beforeEach(async () => {
      await adapter.connect();
      
      fromKeypair = Keypair.generate();
      toKeypair = Keypair.generate();
      
      transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toKeypair.publicKey,
          lamports: 1000000,
        })
      );
    });

    it('should sign transaction successfully', async () => {
      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(true);
      expect(result.signature).toBeDefined();
      expect(result.signature).toBeInstanceOf(Buffer);
      expect(result.signature!.length).toBe(64);
      expect(result.error).toBeUndefined();
    });

    it('should sign transaction without confirmation when disabled', async () => {
      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath, {
        requireConfirmation: false,
      });

      expect(result.success).toBe(true);
      expect(result.signature).toBeDefined();
    });

    it('should simulate user confirmation delay', async () => {
      adapter.setConfig({ confirmationDelay: 100 });
      const startTime = Date.now();

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      const elapsedTime = Date.now() - startTime;
      expect(elapsedTime).toBeGreaterThanOrEqual(100);
      expect(result.success).toBe(true);
    });

    it('should handle user rejection', async () => {
      adapter.setConfig({ simulateUserRejection: true });

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(false);
      expect(result.userRejected).toBe(true);
      expect(result.error).toBe('Simulated user rejection');
    });

    it('should handle timeout', async () => {
      adapter.setConfig({ simulateTimeout: true });

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(false);
      expect(result.timeout).toBe(true);
      expect(result.error).toBe('Simulated confirmation timeout');
    });

    it('should reject transaction that is too large', async () => {
      adapter.setConfig({ maxTransactionSize: 100 }); // Very small limit

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction size');
      expect(result.error).toContain('exceeds maximum');
    });

    it('should sign multiple transactions', async () => {
      const transaction2 = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toKeypair.publicKey,
          lamports: 2000000,
        })
      );

      const derivationPath = "m/44'/501'/0'/0'";
      const results = await adapter.signTransactions([transaction, transaction2], derivationPath);

      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.signature).toBeDefined();
      });
    });

    it('should stop signing when user rejects one transaction', async () => {
      let rejectionSimulated = false;
      const originalConfig = adapter['config'];
      
      // Mock the config to simulate rejection on second transaction
      jest.spyOn(adapter as any, 'simulateUserConfirmation').mockImplementation(async () => {
        if (!rejectionSimulated) {
          rejectionSimulated = true;
          return; // First transaction succeeds
        }
        throw new HardwareWalletException(
          HardwareWalletError.USER_REJECTED,
          'User rejected the transaction'
        );
      });

      const transaction2 = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: toKeypair.publicKey,
          lamports: 2000000,
        })
      );

      const derivationPath = "m/44'/501'/0'/0'";
      const results = await adapter.signTransactions([transaction, transaction2], derivationPath);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].userRejected).toBe(true);
    });

    it('should throw when not connected', async () => {
      await adapter.disconnect();

      const derivationPath = "m/44'/501'/0'/0'";
      await expect(adapter.signTransaction(transaction, derivationPath))
        .rejects.toThrow('Mock device is not connected');
    });
  });

  describe('Device Verification', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should verify device successfully', async () => {
      const isGenuine = await adapter.verifyDevice();
      expect(isGenuine).toBe(true);
    });

    it('should get firmware version', async () => {
      const version = await adapter.getFirmwareVersion();
      expect(version).toBe('1.0.0-mock');
    });

    it('should indicate no firmware update needed', async () => {
      const needsUpdate = await adapter.needsFirmwareUpdate();
      expect(needsUpdate).toBe(false);
    });

    it('should use custom firmware version from config', async () => {
      const customAdapter = new MockAdapter('test', { firmwareVersion: '2.0.0-custom' });
      await customAdapter.connect();

      const version = await customAdapter.getFirmwareVersion();
      expect(version).toBe('2.0.0-custom');

      await customAdapter.disconnect();
    });
  });

  describe('Configuration and Testing Utilities', () => {
    it('should update configuration', () => {
      adapter.setConfig({
        simulateUserRejection: true,
        confirmationDelay: 5000,
      });

      expect(adapter['config'].simulateUserRejection).toBe(true);
      expect(adapter['config'].confirmationDelay).toBe(5000);
    });

    it('should lock and unlock device', async () => {
      await adapter.connect();
      expect(await adapter.isConnected()).toBe(true);

      adapter.lock();
      expect(await adapter.isConnected()).toBe(false);

      adapter.unlock();
      expect(await adapter.isConnected()).toBe(true);
    });

    it('should force disconnect', async () => {
      await adapter.connect();
      expect(await adapter.isConnected()).toBe(true);

      adapter.forceDisconnect();
      expect(await adapter.isConnected()).toBe(false);
      
      const status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(false);
      expect(status.locked).toBe(true);
    });

    it('should provide keypair for testing', async () => {
      await adapter.connect();
      
      const derivationPath = "m/44'/501'/0'/0'";
      const keypair = adapter.getKeypairForTesting(derivationPath);
      const publicKey = await adapter.getPublicKey(derivationPath);

      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey.equals(publicKey)).toBe(true);
    });

    it('should generate different keypairs for different device IDs', async () => {
      const adapter2 = new MockAdapter('different-device');
      await adapter.connect();
      await adapter2.connect();

      const path = "m/44'/501'/0'/0'";
      const key1 = await adapter.getPublicKey(path);
      const key2 = await adapter2.getPublicKey(path);

      expect(key1.equals(key2)).toBe(false);

      await adapter2.disconnect();
    });
  });
});