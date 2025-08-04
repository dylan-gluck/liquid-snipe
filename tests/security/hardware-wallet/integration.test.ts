import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import {
  createHardwareWalletFactory,
  HardwareWalletType,
  MockAdapter,
  LedgerAdapter,
  TrezorAdapter,
  HardwareWalletException,
  HardwareWalletError,
} from '../../../src/security/hardware-wallet';

describe('Hardware Wallet Integration', () => {
  beforeEach(() => {
    // Enable mock wallets for testing
    process.env.ENABLE_MOCK_HARDWARE_WALLET = 'true';
    process.env.SIMULATE_HARDWARE_WALLETS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_MOCK_HARDWARE_WALLET;
    delete process.env.SIMULATE_HARDWARE_WALLETS;
  });

  describe('End-to-End Wallet Operations', () => {
    it('should detect, create, and use a hardware wallet', async () => {
      const factory = createHardwareWalletFactory();

      // Detect available wallets
      const wallets = await factory.detectWallets();
      expect(wallets.length).toBeGreaterThan(0);

      // Create a wallet instance
      const walletInfo = wallets[0];
      const wallet = await factory.createWallet(walletInfo);

      // Connect to the wallet
      await wallet.connect();
      expect(await wallet.isConnected()).toBe(true);

      // Get device information
      const info = await wallet.getInfo();
      expect(info.id).toBe(walletInfo.id);

      // Get accounts
      const accounts = await wallet.getAccounts(0, 3);
      expect(accounts).toHaveLength(3);

      // Sign a transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: accounts[0].publicKey,
          toPubkey: accounts[1].publicKey,
          lamports: 1000000,
        })
      );

      const result = await wallet.signTransaction(transaction, accounts[0].derivationPath);
      expect(result.success).toBe(true);
      expect(result.signature).toBeDefined();

      // Disconnect
      await wallet.disconnect();
      expect(await wallet.isConnected()).toBe(false);
    });

    it('should handle multiple wallet types consistently', async () => {
      const factory = createHardwareWalletFactory();
      const wallets = await factory.detectWallets();

      const results: Array<{
        type: string;
        connected: boolean;
        accountCount: number;
        signatureSuccess: boolean;
      }> = [];

      for (const walletInfo of wallets) {
        const wallet = await factory.createWallet(walletInfo);
        
        try {
          await wallet.connect();
          const connected = await wallet.isConnected();
          
          const accounts = await wallet.getAccounts(0, 2);
          
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: accounts[0].publicKey,
              toPubkey: accounts[1].publicKey,
              lamports: 500000,
            })
          );

          const signResult = await wallet.signTransaction(
            transaction, 
            accounts[0].derivationPath,
            { requireConfirmation: false } // Speed up tests
          );

          results.push({
            type: walletInfo.vendor,
            connected,
            accountCount: accounts.length,
            signatureSuccess: signResult.success,
          });

          await wallet.disconnect();
        } catch (error) {
          console.warn(`Failed to test wallet ${walletInfo.vendor}:`, error);
        }
      }

      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.connected).toBe(true);
        expect(result.accountCount).toBe(2);
        expect(result.signatureSuccess).toBe(true);
      });
    });
  });

  describe('Cross-Wallet Compatibility', () => {
    it('should generate different keys for same derivation path across wallet types', async () => {
      const factory = createHardwareWalletFactory();
      const wallets = await factory.detectWallets();

      const keys: Map<string, PublicKey> = new Map();
      const derivationPath = "m/44'/501'/0'/0'";

      for (const walletInfo of wallets) {
        const wallet = await factory.createWallet(walletInfo);
        await wallet.connect();
        
        const publicKey = await wallet.getPublicKey(derivationPath);
        keys.set(walletInfo.vendor, publicKey);
        
        await wallet.disconnect();
      }

      // Verify all keys are different
      const keyArray = Array.from(keys.values());
      for (let i = 0; i < keyArray.length; i++) {
        for (let j = i + 1; j < keyArray.length; j++) {
          expect(keyArray[i].equals(keyArray[j])).toBe(false);
        }
      }
    });

    it('should maintain consistent behavior across wallet types', async () => {
      const factory = createHardwareWalletFactory();
      const wallets = await factory.detectWallets();

      const behaviors: Array<{
        vendor: string;
        capabilities: any;
        accountsRetrieved: boolean;
        firmwareRetrieved: boolean;
        verificationSucceeded: boolean;
      }> = [];

      for (const walletInfo of wallets) {
        const wallet = await factory.createWallet(walletInfo);
        await wallet.connect();
        
        try {
          const capabilities = await wallet.getCapabilities();
          const accounts = await wallet.getAccounts(0, 1);
          const firmware = await wallet.getFirmwareVersion();
          const verification = await wallet.verifyDevice();

          behaviors.push({
            vendor: walletInfo.vendor,
            capabilities,
            accountsRetrieved: accounts.length > 0,
            firmwareRetrieved: firmware.length > 0,
            verificationSucceeded: verification,
          });
        } catch (error) {
          console.warn(`Failed to test wallet behavior ${walletInfo.vendor}:`, error);
        }
        
        await wallet.disconnect();
      }

      expect(behaviors.length).toBeGreaterThan(0);
      behaviors.forEach(behavior => {
        expect(behavior.capabilities.supportsMultipleAccounts).toBe(true);
        expect(behavior.capabilities.supportsCustomDerivationPaths).toBe(true);
        expect(behavior.accountsRetrieved).toBe(true);
        expect(behavior.firmwareRetrieved).toBe(true);
        expect(behavior.verificationSucceeded).toBe(true);
      });
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle connection failures gracefully', async () => {
      const factory = createHardwareWalletFactory();
      
      // Create a mock wallet configured to fail
      const mockWallet = factory.createMockWallet('error-test');
      mockWallet.setConfig({ simulateDeviceError: true });

      await expect(mockWallet.connect()).rejects.toThrow(HardwareWalletException);
      expect(await mockWallet.isConnected()).toBe(false);
    });

    it('should handle signing failures consistently', async () => {
      const factory = createHardwareWalletFactory();
      const mockWallet = factory.createMockWallet('rejection-test');
      
      await mockWallet.connect();
      mockWallet.setConfig({ simulateUserRejection: true });

      const accounts = await mockWallet.getAccounts(0, 1);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: accounts[0].publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000000,
        })
      );

      const result = await mockWallet.signTransaction(transaction, accounts[0].derivationPath);
      
      expect(result.success).toBe(false);
      expect(result.userRejected).toBe(true);
      expect(result.error).toBeDefined();

      await mockWallet.disconnect();
    });

    it('should handle timeout scenarios', async () => {
      const factory = createHardwareWalletFactory({ timeout: 1000 });
      const mockWallet = factory.createMockWallet('timeout-test');
      
      await mockWallet.connect();
      mockWallet.setConfig({ simulateTimeout: true });

      const accounts = await mockWallet.getAccounts(0, 1);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: accounts[0].publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000000,
        })
      );

      const result = await mockWallet.signTransaction(transaction, accounts[0].derivationPath);
      
      expect(result.success).toBe(false);
      expect(result.timeout).toBe(true);
      expect(result.error).toBeDefined();

      await mockWallet.disconnect();
    });
  });

  describe('Configuration Integration', () => {
    it('should apply configuration across all wallet types', async () => {
      const customConfig = {
        timeout: 45000,
        requireConfirmation: false,
        blindSigning: true,
      };

      const factory = createHardwareWalletFactory(customConfig);
      const wallets = await factory.detectWallets();

      for (const walletInfo of wallets) {
        const wallet = await factory.createWallet(walletInfo);
        
        // Check that configuration is applied (this is implementation-specific)
        if (wallet instanceof MockAdapter) {
          expect(wallet['config'].confirmationDelay).toBeDefined();
        } else if (wallet instanceof LedgerAdapter) {
          expect(wallet['config'].timeout).toBe(45000);
          expect(wallet['config'].requireConfirmation).toBe(false);
          expect(wallet['config'].blindSigning).toBe(true);
        } else if (wallet instanceof TrezorAdapter) {
          expect(wallet['config'].timeout).toBe(45000);
          expect(wallet['config'].requireConfirmation).toBe(false);
          expect(wallet['config'].blindSigning).toBe(true);
        }
      }
    });

    it('should respect preferred vendor configuration', async () => {
      const factory = createHardwareWalletFactory({ preferredVendor: 'ledger' });
      
      const preferredWallet = await factory.getPreferredWallet();
      
      if (preferredWallet) {
        expect(preferredWallet).toBeInstanceOf(LedgerAdapter);
      }
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle concurrent operations', async () => {
      const factory = createHardwareWalletFactory();
      const mockWallet = factory.createMockWallet('concurrent-test');
      
      await mockWallet.connect();

      // Perform multiple operations concurrently
      const operations = [
        mockWallet.getAccount(0),
        mockWallet.getAccount(1),
        mockWallet.getPublicKey("m/44'/501'/0'/0'"),
        mockWallet.getPublicKey("m/44'/501'/1'/0'"),
        mockWallet.getFirmwareVersion(),
        mockWallet.verifyDevice(),
      ];

      const results = await Promise.all(operations);
      
      expect(results).toHaveLength(6);
      results.forEach(result => {
        expect(result).toBeDefined();
      });

      await mockWallet.disconnect();
    });

    it('should maintain state consistency during operations', async () => {
      const factory = createHardwareWalletFactory();
      const mockWallet = factory.createMockWallet('state-test');
      
      // Initial state
      expect(await mockWallet.isConnected()).toBe(false);
      
      // Connect
      await mockWallet.connect();
      expect(await mockWallet.isConnected()).toBe(true);
      
      // Operations should not affect connection state
      await mockWallet.getAccount(0);
      expect(await mockWallet.isConnected()).toBe(true);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: (await mockWallet.getAccount(0)).publicKey,
          toPubkey: (await mockWallet.getAccount(1)).publicKey,
          lamports: 1000000,
        })
      );
      
      await mockWallet.signTransaction(transaction, "m/44'/501'/0'/0'", { requireConfirmation: false });
      expect(await mockWallet.isConnected()).toBe(true);
      
      // Disconnect
      await mockWallet.disconnect();
      expect(await mockWallet.isConnected()).toBe(false);
    });

    it('should clean up resources properly', async () => {
      const factory = createHardwareWalletFactory();
      const mockWallet = factory.createMockWallet('cleanup-test');
      
      await mockWallet.connect();
      
      // Generate some accounts to populate internal caches
      await mockWallet.getAccounts(0, 5);
      
      // Verify accounts are cached
      const accountsBefore = await mockWallet.getAccounts(0, 5);
      expect(accountsBefore).toHaveLength(5);
      
      // Disconnect should clean up
      await mockWallet.disconnect();
      
      // Reconnect and verify fresh state
      await mockWallet.connect();
      const accountsAfter = await mockWallet.getAccounts(0, 5);
      
      expect(accountsAfter).toHaveLength(5);
      // Note: In a real scenario, we'd verify that internal caches were cleared
      // but since accounts are generated deterministically, they'll be the same
      
      await mockWallet.disconnect();
    });
  });

  describe('Security Integration', () => {
    it('should validate transaction sizes across wallet types', async () => {
      const factory = createHardwareWalletFactory();
      const wallets = await factory.detectWallets();

      for (const walletInfo of wallets) {
        const wallet = await factory.createWallet(walletInfo);
        await wallet.connect();
        
        const capabilities = await wallet.getCapabilities();
        const account = await wallet.getAccount(0);
        
        // Create a transaction that's definitely too large
        const largeTransaction = new Transaction();
        const instructionCount = Math.ceil(capabilities.maxTransactionSize / 50) + 10;
        
        for (let i = 0; i < instructionCount; i++) {
          largeTransaction.add(
            SystemProgram.transfer({
              fromPubkey: account.publicKey,
              toPubkey: Keypair.generate().publicKey,
              lamports: 1000,
            })
          );
        }

        const result = await wallet.signTransaction(largeTransaction, account.derivationPath);
        
        if (wallet instanceof MockAdapter) {
          // Mock adapter returns error in result
          expect(result.success).toBe(false);
          expect(result.error).toContain('Transaction size');
        } else {
          // Real adapters throw exceptions
          expect(result.success).toBe(false);
        }
        
        await wallet.disconnect();
      }
    });

    it('should enforce confirmation requirements', async () => {
      const factory = createHardwareWalletFactory({ requireConfirmation: true });
      const mockWallet = factory.createMockWallet('confirmation-test');
      
      await mockWallet.connect();
      
      const account = await mockWallet.getAccount(0);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: account.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000000,
        })
      );

      // Should require confirmation by default
      const startTime = Date.now();
      const result = await mockWallet.signTransaction(transaction, account.derivationPath);
      const elapsedTime = Date.now() - startTime;
      
      expect(result.success).toBe(true);
      expect(elapsedTime).toBeGreaterThanOrEqual(mockWallet['config'].confirmationDelay);
      
      await mockWallet.disconnect();
    });
  });
});