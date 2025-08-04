// No need to import from @jest/globals - Jest globals are available by default
import { TradingWorkflowCoordinator } from '../../src/core/workflows/trading-workflow';
import { EventManager } from '../../src/events/event-manager';
import { StrategyEngine } from '../../src/trading/strategy-engine';
import { TradeExecutor } from '../../src/trading/trade-executor';
import DatabaseManager from '../../src/db';
import { NewPoolEvent, TradeDecision, TradeResult } from '../../src/types';

// Mock dependencies
jest.mock('../../src/events/event-manager');
jest.mock('../../src/trading/strategy-engine');
jest.mock('../../src/trading/trade-executor');
jest.mock('../../src/db');

describe('TradingWorkflowCoordinator', () => {
  let tradingWorkflow: TradingWorkflowCoordinator;
  let mockEventManager: jest.Mocked<EventManager>;
  let mockStrategyEngine: jest.Mocked<StrategyEngine>;
  let mockTradeExecutor: jest.Mocked<TradeExecutor>;
  let mockDbManager: jest.Mocked<DatabaseManager>;

  beforeEach(() => {
    // Create mock instances
    mockEventManager = {
      on: jest.fn(),
      emit: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    } as any;

    mockStrategyEngine = {
      evaluatePool: jest.fn(),
    } as any;

    mockTradeExecutor = {
      executeTrade: jest.fn(),
    } as any;

    mockDbManager = {} as any;

    // Create trading workflow coordinator
    tradingWorkflow = new TradingWorkflowCoordinator(
      mockEventManager,
      mockStrategyEngine,
      mockTradeExecutor,
      mockDbManager,
      false // not dry run
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Event Handler Setup', () => {
    it('should register event handlers during construction', () => {
      expect(mockEventManager.on).toHaveBeenCalledWith('newPool', expect.any(Function));
      expect(mockEventManager.on).toHaveBeenCalledWith('tradeDecision', expect.any(Function));
      expect(mockEventManager.on).toHaveBeenCalledWith('tradeResult', expect.any(Function));
    });
  });

  describe('New Pool Workflow', () => {
    const mockPoolEvent: NewPoolEvent = {
      signature: 'test_signature_123',
      dex: 'Raydium',
      poolAddress: 'pool_address_123',
      tokenA: 'token_a_address',
      tokenB: 'token_b_address',
      timestamp: Date.now()
    };

    it('should handle new pool event and create workflow', async () => {
      const mockDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'token_a_address',
        baseToken: 'token_b_address',
        poolAddress: 'pool_address_123',
        tradeAmountUsd: 100,
        reason: 'Good opportunity',
        riskScore: 3
      };

      mockStrategyEngine.evaluatePool.mockResolvedValue(mockDecision);

      // Get the event handler that was registered
      const newPoolHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'newPool')?.[1];

      expect(newPoolHandler).toBeDefined();

      // Call the handler directly
      await newPoolHandler!(mockPoolEvent);

      // Verify strategy engine was called
      expect(mockStrategyEngine.evaluatePool).toHaveBeenCalledWith(mockPoolEvent);

      // Verify trade decision was emitted
      expect(mockEventManager.emit).toHaveBeenCalledWith('tradeDecision', mockDecision);

      // Verify workflow state
      const workflows = tradingWorkflow.getActiveWorkflows();
      expect(workflows.size).toBe(1);
      
      const workflowId = `pool_${mockPoolEvent.signature}`;
      const workflowState = tradingWorkflow.getWorkflowState(workflowId);
      expect(workflowState).toBeDefined();
      expect(workflowState!.poolEvaluation).toBe('COMPLETED');
    });

    it('should handle pool evaluation that results in no trade', async () => {
      mockStrategyEngine.evaluatePool.mockResolvedValue(null);

      const newPoolHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'newPool')?.[1];

      await newPoolHandler!(mockPoolEvent);

      // Verify no trade decision was emitted
      expect(mockEventManager.emit).not.toHaveBeenCalledWith('tradeDecision', expect.anything());

      // Verify workflow was cleaned up
      const workflows = tradingWorkflow.getActiveWorkflows();
      expect(workflows.size).toBe(0);
    });

    it('should handle pool evaluation errors', async () => {
      const error = new Error('Evaluation failed');
      mockStrategyEngine.evaluatePool.mockRejectedValue(error);

      const newPoolHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'newPool')?.[1];

      await newPoolHandler!(mockPoolEvent);

      // Verify workflow was cleaned up after error
      const workflows = tradingWorkflow.getActiveWorkflows();
      expect(workflows.size).toBe(0);
    });
  });

  describe('Trade Decision Workflow', () => {
    const mockDecision: TradeDecision = {
      shouldTrade: true,
      targetToken: 'token_a_address',
      baseToken: 'token_b_address',
      poolAddress: 'pool_address_123',
      tradeAmountUsd: 100,
      reason: 'Good opportunity',
      riskScore: 3
    };

    beforeEach(() => {
      // Create a workflow first
      const workflowId = 'pool_test_signature';
      (tradingWorkflow as any).activeWorkflows.set(workflowId, {
        poolEvaluation: 'COMPLETED',
        tradeDecision: 'PENDING',
        tradeExecution: 'PENDING'
      });
    });

    it('should execute trade when decision is positive', async () => {
      const mockResult: TradeResult = {
        success: true,
        signature: 'trade_signature_123',
        tradeId: 'trade_id_123',
        positionId: 'position_id_123',
        timestamp: Date.now()
      };

      mockTradeExecutor.executeTrade.mockResolvedValue(mockResult);

      const tradeDecisionHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeDecision')?.[1];

      await tradeDecisionHandler!(mockDecision);

      expect(mockTradeExecutor.executeTrade).toHaveBeenCalledWith(mockDecision);
      expect(mockEventManager.emit).toHaveBeenCalledWith('tradeResult', mockResult);
    });

    it('should skip trade when decision is negative', async () => {
      const negativeDecision: TradeDecision = {
        ...mockDecision,
        shouldTrade: false,
        reason: 'Too risky'
      };

      const tradeDecisionHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeDecision')?.[1];

      await tradeDecisionHandler!(negativeDecision);

      expect(mockTradeExecutor.executeTrade).not.toHaveBeenCalled();
    });

    it('should handle trade execution errors', async () => {
      const error = new Error('Trade execution failed');
      mockTradeExecutor.executeTrade.mockRejectedValue(error);

      const tradeDecisionHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeDecision')?.[1];

      await tradeDecisionHandler!(mockDecision);

      expect(mockEventManager.emit).toHaveBeenCalledWith('tradeResult', {
        success: false,
        error: 'Trade execution failed',
        timestamp: expect.any(Number)
      });
    });
  });

  describe('Dry Run Mode', () => {
    let dryRunWorkflow: TradingWorkflowCoordinator;

    beforeEach(() => {
      dryRunWorkflow = new TradingWorkflowCoordinator(
        mockEventManager,
        mockStrategyEngine,
        mockTradeExecutor,
        mockDbManager,
        true // dry run mode
      );
    });

    it('should emit mock result in dry run mode', async () => {
      const mockDecision: TradeDecision = {
        shouldTrade: true,
        targetToken: 'token_a_address',
        baseToken: 'token_b_address',
        poolAddress: 'pool_address_123',
        tradeAmountUsd: 100,
        reason: 'Good opportunity',
        riskScore: 3
      };

      // Create a workflow
      (dryRunWorkflow as any).activeWorkflows.set('pool_test', {
        poolEvaluation: 'COMPLETED',
        tradeDecision: 'PENDING',
        tradeExecution: 'PENDING'
      });

      const tradeDecisionHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeDecision')?.[1];

      await tradeDecisionHandler!(mockDecision);

      // Should not execute real trade
      expect(mockTradeExecutor.executeTrade).not.toHaveBeenCalled();

      // Should emit dry run result
      expect(mockEventManager.emit).toHaveBeenCalledWith('tradeResult', {
        success: true,
        signature: 'DRY_RUN_SIGNATURE',
        tradeId: 'DRY_RUN_TRADE',
        positionId: 'DRY_RUN_POSITION',
        timestamp: expect.any(Number)
      });
    });
  });

  describe('State Machine Integration', () => {
    it('should create and manage state machines for workflows', () => {
      const workflowId = 'pool_test_signature';
      
      // Simulate workflow creation (normally done in handleNewPoolWorkflow)
      const stateMachines = tradingWorkflow.getActiveStateMachines();
      expect(stateMachines).toBeDefined();
    });

    it('should cleanup state machines when workflow completes', () => {
      const workflowId = 'pool_test_signature';
      
      // Create workflow and state machine
      (tradingWorkflow as any).activeWorkflows.set(workflowId, {
        poolEvaluation: 'COMPLETED',
        tradeDecision: 'COMPLETED',
        tradeExecution: 'COMPLETED'
      });

      // Cleanup should remove both workflow and state machine
      (tradingWorkflow as any).cleanupWorkflow(workflowId);

      const workflows = tradingWorkflow.getActiveWorkflows();
      const stateMachines = tradingWorkflow.getActiveStateMachines();
      
      expect(workflows.has(workflowId)).toBe(false);
      expect(stateMachines.has(workflowId)).toBe(false);
    });
  });

  describe('Workflow State Management', () => {
    it('should provide access to workflow states', () => {
      const workflowId = 'pool_test_signature';
      const mockState = {
        poolEvaluation: 'COMPLETED' as const,
        tradeDecision: 'IN_PROGRESS' as const,
        tradeExecution: 'PENDING' as const
      };

      (tradingWorkflow as any).activeWorkflows.set(workflowId, mockState);

      const retrievedState = tradingWorkflow.getWorkflowState(workflowId);
      expect(retrievedState).toEqual(mockState);

      const allWorkflows = tradingWorkflow.getActiveWorkflows();
      expect(allWorkflows.get(workflowId)).toEqual(mockState);
    });

    it('should return null for non-existent workflow', () => {
      const state = tradingWorkflow.getWorkflowState('non_existent');
      expect(state).toBeNull();
    });
  });
});