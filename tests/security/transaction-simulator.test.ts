import { Connection, Transaction, PublicKey, Keypair } from '@solana/web3.js';
import { 
  TransactionSimulator, 
  TransactionSecurityConfig,
  SimulationResult,
  SlippageValidation,
  MEVProtectionAnalysis,
  GasValidation 
} from '../../src/security/transaction-simulator';

// Mock the Connection class
jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  Connection: jest.fn(),
}));

describe('TransactionSimulator', () => {
  let simulator: TransactionSimulator;
  let mockConnection: jest.Mocked<Connection>;
  let config: TransactionSecurityConfig;
  let testKeypair: Keypair;
  let testTransaction: Transaction;

  beforeEach(() => {
    // Create mock connection
    mockConnection = {
      simulateTransaction: jest.fn(),
      getLatestBlockhash: jest.fn(),
      getFeeForMessage: jest.fn(),
      getRecentBlockhash: jest.fn(),
    } as any;

    // Test configuration
    config = {
      maxSlippagePercent: 5,
      maxGasFeeUsd: 10,
      maxPriceImpactPercent: 3,
      mevProtectionEnabled: true,
      simulationRequired: true,
      maxComputeUnits: 200000,
    };

    simulator = new TransactionSimulator(mockConnection, config);
    testKeypair = Keypair.generate();
    testTransaction = new Transaction();

    // Setup default mocks
    mockConnection.getLatestBlockhash.mockResolvedValue({
      blockhash: 'test-blockhash',
      lastValidBlockHeight: 12345,
    });

    mockConnection.getRecentBlockhash.mockResolvedValue({
      feeCalculator: { lamportsPerSignature: 5000 },
      blockhash: 'test-blockhash',
    });

    mockConnection.getFeeForMessage.mockResolvedValue({
      context: { slot: 12345 },
      value: 5000,
    });
  });

  describe('simulateTransaction', () => {
    it('should successfully simulate a valid transaction', async () => {
      // Mock successful simulation
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: null,
          logs: ['Program log: Success'],
          unitsConsumed: 50000,
        },
      });

      const result = await simulator.simulateTransaction(testTransaction, testKeypair.publicKey);

      expect(result.success).toBe(true);
      expect(result.logs).toEqual(['Program log: Success']);
      expect(result.unitsConsumed).toBe(50000);
      expect(result.warnings).toEqual([]);
    });

    it('should handle simulation failures', async () => {
      // Mock failed simulation
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: { InstructionError: [0, 'CustomError'] },
          logs: ['Program log: Error occurred'],
          unitsConsumed: 0,
        },
      });

      const result = await simulator.simulateTransaction(testTransaction, testKeypair.publicKey);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation failed');
      expect(result.logs).toEqual(['Program log: Error occurred']);
    });

    it('should detect warnings in simulation logs', async () => {
      // Mock simulation with warning logs
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: null,
          logs: [
            'Program log: insufficient balance',
            'Program log: slippage warning',
            'Program log: Success',
          ],
          unitsConsumed: 75000,
        },
      });

      const result = await simulator.simulateTransaction(testTransaction, testKeypair.publicKey);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Insufficient balance detected in simulation');
      expect(result.warnings).toContain('Slippage warning in simulation logs');
    });

    it('should warn about high compute unit usage', async () => {
      // Mock simulation with high compute units
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: null,
          logs: ['Program log: Success'],
          unitsConsumed: 250000, // Above maxComputeUnits
        },
      });

      const result = await simulator.simulateTransaction(testTransaction, testKeypair.publicKey);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('High compute units usage: 250000');
    });

    it('should handle simulation errors gracefully', async () => {
      // Mock connection error
      mockConnection.simulateTransaction.mockRejectedValue(new Error('Network error'));

      const result = await simulator.simulateTransaction(testTransaction, testKeypair.publicKey);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('validateSlippage', () => {
    it('should validate acceptable slippage', () => {
      const result = simulator.validateSlippage(1000, 950); // 5% slippage

      expect(result.isValid).toBe(true);
      expect(result.expectedAmountOut).toBe(1000);
      expect(result.minimumAmountOut).toBe(950);
      expect(result.maxSlippagePercent).toBe(5);
    });

    it('should reject excessive slippage', () => {
      const result = simulator.validateSlippage(1000, 900); // 10% slippage (exceeds 5% max)

      expect(result.isValid).toBe(false);
      expect(result.warning).toContain('Minimum amount out too low');
    });

    it('should validate actual slippage when provided', () => {
      const result = simulator.validateSlippage(1000, 950, 940); // Actual slippage 6%

      expect(result.isValid).toBe(false);
      expect(result.actualSlippage).toBeCloseTo(0.06, 2);
      expect(result.warning).toContain('Actual slippage 6.00% exceeds maximum 5%');
    });

    it('should accept actual slippage within limits', () => {
      const result = simulator.validateSlippage(1000, 950, 970); // Actual slippage 3%

      expect(result.isValid).toBe(true);
      expect(result.actualSlippage).toBeCloseTo(0.03, 2);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('analyzeMEVProtection', () => {
    it('should return low risk for small transactions', async () => {
      const result = await simulator.analyzeMEVProtection(testTransaction);

      expect(result.riskLevel).toBe('LOW');
      expect(result.shouldProceed).toBe(true);
      expect(result.recommendations).toHaveLength(0);
    });

    it('should detect high MEV risk for large value transactions', async () => {
      // Mock a high-value transaction by adding instructions
      for (let i = 0; i < 20; i++) {
        testTransaction.add({
          keys: [],
          programId: PublicKey.default,
          data: Buffer.alloc(0),
        });
      }

      const result = await simulator.analyzeMEVProtection(testTransaction);

      expect(result.frontRunningRisk).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('should return conservative analysis when MEV protection is disabled', async () => {
      // Create simulator with MEV protection disabled
      const disabledConfig = { ...config, mevProtectionEnabled: false };
      const disabledSimulator = new TransactionSimulator(mockConnection, disabledConfig);

      const result = await disabledSimulator.analyzeMEVProtection(testTransaction);

      expect(result.riskLevel).toBe('LOW');
      expect(result.recommendations).toContain('MEV protection disabled');
      expect(result.shouldProceed).toBe(true);
    });

    it('should handle MEV analysis errors gracefully', async () => {
      // Force an error by making the transaction invalid
      const invalidTransaction = null as any;

      const result = await simulator.analyzeMEVProtection(invalidTransaction);

      expect(result.riskLevel).toBe('MEDIUM');
      expect(result.recommendations).toContain('MEV analysis failed - proceed with caution');
    });
  });

  describe('validateGasLimits', () => {
    it('should validate reasonable gas fees', async () => {
      const result = await simulator.validateGasLimits(testTransaction);

      expect(result.isReasonable).toBe(true);
      expect(result.estimatedFeeSol).toBe(0.005); // 5000 lamports
      expect(result.estimatedFeeUsd).toBe(0.5); // Mock SOL price $100
      expect(result.warning).toBeUndefined();
    });

    it('should warn about high gas fees', async () => {
      // Mock high gas fee
      mockConnection.getFeeForMessage.mockResolvedValue({
        context: { slot: 12345 },
        value: 150000, // High fee
      });

      const result = await simulator.validateGasLimits(testTransaction);

      expect(result.isReasonable).toBe(false);
      expect(result.estimatedFeeUsd).toBe(15); // Above maxGasFeeUsd
      expect(result.warning).toContain('Estimated gas fee 15.0000 USD exceeds maximum 10 USD');
    });

    it('should warn about complex transactions', async () => {
      // Add many instructions
      for (let i = 0; i < 15; i++) {
        testTransaction.add({
          keys: [],
          programId: PublicKey.default,
          data: Buffer.alloc(0),
        });
      }

      const result = await simulator.validateGasLimits(testTransaction);

      expect(result.warning).toContain('Transaction has 15 instructions - may be complex or inefficient');
    });

    it('should handle gas validation errors gracefully', async () => {
      // Mock connection error
      mockConnection.getFeeForMessage.mockRejectedValue(new Error('Network error'));

      const result = await simulator.validateGasLimits(testTransaction);

      expect(result.isReasonable).toBe(true);
      expect(result.warning).toBe('Gas validation failed - using default estimates');
    });
  });

  describe('validateTransaction', () => {
    beforeEach(() => {
      // Setup successful simulation mock
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: null,
          logs: ['Program log: Success'],
          unitsConsumed: 50000,
        },
      });
    });

    it('should perform comprehensive transaction validation', async () => {
      const result = await simulator.validateTransaction(
        testTransaction,
        testKeypair.publicKey,
        1000,
        950
      );

      expect(result.isValid).toBe(true);
      expect(result.simulation.success).toBe(true);
      expect(result.slippage?.isValid).toBe(true);
      expect(result.mevAnalysis.shouldProceed).toBe(true);
      expect(result.gasValidation.isReasonable).toBe(true);
      expect(result.overallRisk).toBe('LOW');
    });

    it('should identify invalid transactions', async () => {
      // Mock failed simulation
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: { InstructionError: [0, 'Error'] },
          logs: ['Program log: Failed'],
          unitsConsumed: 0,
        },
      });

      const result = await simulator.validateTransaction(
        testTransaction,
        testKeypair.publicKey,
        1000,
        800 // Excessive slippage
      );

      expect(result.isValid).toBe(false);
      expect(result.simulation.success).toBe(false);
      expect(result.slippage?.isValid).toBe(false);
    });

    it('should compile comprehensive recommendations', async () => {
      // Mock simulation with warnings
      mockConnection.simulateTransaction.mockResolvedValue({
        context: { slot: 12345 },
        value: {
          err: null,
          logs: ['Program log: slippage warning', 'Program log: Success'],
          unitsConsumed: 250000, // High compute units
        },
      });

      const result = await simulator.validateTransaction(
        testTransaction,
        testKeypair.publicKey,
        1000,
        900 // High slippage
      );

      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations.some(r => r.includes('slippage'))).toBe(true);
      expect(result.recommendations.some(r => r.includes('compute units'))).toBe(true);
    });

    it('should handle validation without slippage parameters', async () => {
      const result = await simulator.validateTransaction(
        testTransaction,
        testKeypair.publicKey
      );

      expect(result.slippage).toBeUndefined();
      expect(result.simulation.success).toBe(true);
      expect(result.mevAnalysis).toBeDefined();
      expect(result.gasValidation).toBeDefined();
    });
  });

  describe('configuration', () => {
    it('should update configuration correctly', () => {
      const newConfig = {
        maxSlippagePercent: 3,
        maxGasFeeUsd: 5,
      };

      simulator.updateConfig(newConfig);

      // Test that the configuration was updated by validating slippage
      const result = simulator.validateSlippage(1000, 960); // 4% slippage
      expect(result.isValid).toBe(false); // Should fail with new 3% limit
    });
  });
});