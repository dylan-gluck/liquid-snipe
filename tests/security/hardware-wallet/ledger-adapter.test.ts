import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { LedgerAdapter } from '../../../src/security/hardware-wallet/ledger-adapter';
import { HardwareWalletError, HardwareWalletException } from '../../../src/security/hardware-wallet/interface';

describe('LedgerAdapter', () => {
  let adapter: LedgerAdapter;

  beforeEach(() => {
    adapter = new LedgerAdapter('/dev/hidraw0');
  });

  afterEach(async () => {
    try {
      if (await adapter.isConnected()) {
        await adapter.disconnect();
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('Device Information', () => {
    it('should return correct device info', async () => {
      const info = await adapter.getInfo();

      expect(info).toEqual({
        id: 'ledger-/dev/hidraw0',
        name: 'Ledger Nano S Plus',
        model: 'Nano S Plus',
        vendor: 'Ledger',
        path: '/dev/hidraw0',
        connected: false,
      });
    });

    it('should return connection status', async () => {
      let status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(false);
      expect(status.locked).toBe(true);
      expect(status.appOpen).toBe(false);

      await adapter.connect();
      status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(true);
      expect(status.locked).toBe(false);
      expect(status.appOpen).toBe(true);
      expect(status.appName).toBe('Solana');
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
      expect(status.appOpen).toBe(true);
    });

    it('should disconnect successfully', async () => {
      await adapter.connect();
      expect(await adapter.isConnected()).toBe(true);

      await adapter.disconnect();

      expect(await adapter.isConnected()).toBe(false);
      const status = await adapter.getConnectionStatus();
      expect(status.connected).toBe(false);
      expect(status.locked).toBe(true);
      expect(status.appOpen).toBe(false);
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
      await expect(adapter.getAccount(0)).rejects.toThrow('Ledger device is not connected');
    });

    it('should throw when device is locked', async () => {
      // Force the device to be locked
      adapter['locked'] = true;

      await expect(adapter.getAccount(0)).rejects.toThrow(HardwareWalletException);
      await expect(adapter.getAccount(0)).rejects.toThrow('Ledger device is locked');
    });

    it('should throw when app is not open', async () => {
      // Force the app to be closed
      adapter['appOpen'] = false;

      await expect(adapter.getAccount(0)).rejects.toThrow(HardwareWalletException);
      await expect(adapter.getAccount(0)).rejects.toThrow('Solana app is not open on Ledger device');
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

    it('should sign transaction with custom options', async () => {
      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath, {
        requireConfirmation: false,
        displayTransaction: false,
        blindSigning: true,
        timeout: 60000,
      });

      expect(result.success).toBe(true);
      expect(result.signature).toBeDefined();
    });

    it('should reject transaction that is too large', async () => {
      // Create a very large transaction by adding many instructions
      const largeTransaction = new Transaction();
      for (let i = 0; i < 50; i++) {
        largeTransaction.add(
          SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: toKeypair.publicKey,
            lamports: 1000,
          })
        );
      }

      const derivationPath = "m/44'/501'/0'/0'";
      await expect(adapter.signTransaction(largeTransaction, derivationPath))
        .rejects.toThrow(HardwareWalletException);
    });

    it('should handle user confirmation timeout', async () => {
      // Mock the user confirmation to always timeout
      jest.spyOn(adapter as any, 'simulateUserConfirmation').mockImplementation(async () => {
        throw new HardwareWalletException(
          HardwareWalletError.TIMEOUT,
          'User confirmation timeout'
        );
      });

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User confirmation timeout');
    });

    it('should handle user rejection', async () => {
      // Mock the user confirmation to simulate rejection
      jest.spyOn(adapter as any, 'simulateUserConfirmation').mockImplementation(async () => {
        throw new HardwareWalletException(
          HardwareWalletError.USER_REJECTED,
          'User rejected the transaction'
        );
      });

      const derivationPath = "m/44'/501'/0'/0'";
      const result = await adapter.signTransaction(transaction, derivationPath);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User rejected the transaction');
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
      let callCount = 0;
      jest.spyOn(adapter as any, 'simulateUserConfirmation').mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new HardwareWalletException(
            HardwareWalletError.USER_REJECTED,
            'User rejected the transaction'
          );
        }
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
    });

    it('should throw when not connected', async () => {
      await adapter.disconnect();

      const derivationPath = "m/44'/501'/0'/0'";
      await expect(adapter.signTransaction(transaction, derivationPath))
        .rejects.toThrow('Ledger device is not connected');
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
      expect(version).toBe('2.1.0');
    });

    it('should check if firmware update is needed', async () => {
      const needsUpdate = await adapter.needsFirmwareUpdate();
      expect(needsUpdate).toBe(false);
    });

    it('should indicate firmware update needed for old version', async () => {
      // Mock the firmware version to be old
      jest.spyOn(adapter, 'getFirmwareVersion').mockResolvedValue('1.9.0');

      const needsUpdate = await adapter.needsFirmwareUpdate();
      expect(needsUpdate).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should use custom configuration', () => {
      const customAdapter = new LedgerAdapter('/dev/hidraw1', {
        timeout: 60000,
        requireConfirmation: false,
        blindSigning: true,
        debug: true,
      });

      expect(customAdapter['config'].timeout).toBe(60000);
      expect(customAdapter['config'].requireConfirmation).toBe(false);
      expect(customAdapter['config'].blindSigning).toBe(true);
      expect(customAdapter['config'].debug).toBe(true);
    });

    it('should merge with default configuration', () => {
      const customAdapter = new LedgerAdapter('/dev/hidraw1', {
        timeout: 45000,
      });

      expect(customAdapter['config'].timeout).toBe(45000);
      expect(customAdapter['config'].requireConfirmation).toBe(true); // Default value
      expect(customAdapter['config'].blindSigning).toBe(false); // Default value
    });
  });

  describe('Error Handling', () => {
    it('should handle connection errors gracefully', async () => {
      // Mock a connection error
      jest.spyOn(adapter as any, 'simulateDelay').mockImplementation(async () => {
        throw new Error('USB connection failed');
      });

      await expect(adapter.connect()).rejects.toThrow(HardwareWalletException);
      await expect(adapter.connect()).rejects.toThrow('Failed to connect to Ledger device');
    });

    it('should handle disconnection errors gracefully', async () => {
      await adapter.connect();

      // Mock a disconnection error
      jest.spyOn(adapter as any, 'simulateDelay').mockImplementation(async () => {
        throw new Error('USB disconnection failed');
      });

      await expect(adapter.disconnect()).rejects.toThrow(HardwareWalletException);
      await expect(adapter.disconnect()).rejects.toThrow('Failed to disconnect from Ledger device');
    });

    it('should handle public key retrieval errors', async () => {
      await adapter.connect();

      // Mock an error in public key generation
      jest.spyOn(adapter as any, 'hashDerivationPath').mockImplementation(() => {
        throw new Error('Hash generation failed');
      });

      const derivationPath = "m/44'/501'/0'/0'";
      await expect(adapter.getPublicKey(derivationPath)).rejects.toThrow(HardwareWalletException);
    });
  });
});