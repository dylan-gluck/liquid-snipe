// No need to import from @jest/globals - Jest globals are available by default
import { PositionWorkflowCoordinator } from '../../src/core/workflows/position-workflow';
import { EventManager } from '../../src/events/event-manager';
import { PositionManager } from '../../src/trading/position-manager';
import DatabaseManager from '../../src/db';
import { TradeResult } from '../../src/types';

// Mock dependencies
jest.mock('../../src/events/event-manager');
jest.mock('../../src/trading/position-manager');
jest.mock('../../src/db');

describe('PositionWorkflowCoordinator', () => {
  let positionWorkflow: PositionWorkflowCoordinator;
  let mockEventManager: jest.Mocked<EventManager>;
  let mockPositionManager: jest.Mocked<PositionManager>;
  let mockDbManager: jest.Mocked<DatabaseManager>;

  beforeEach(() => {
    // Create mock instances
    mockEventManager = {
      on: jest.fn(),
      emit: jest.fn(),
      off: jest.fn(),
      removeAllListeners: jest.fn(),
    } as any;

    mockPositionManager = {
      getPosition: jest.fn(),
      evaluateExitConditions: jest.fn(),
      processExitRequest: jest.fn(),
    } as any;

    mockDbManager = {
      getOpenPositions: jest.fn(),
    } as any;

    // Create position workflow coordinator
    positionWorkflow = new PositionWorkflowCoordinator(
      mockEventManager,
      mockPositionManager,
      mockDbManager,
      false, // not dry run
      1000 // 1 second monitoring interval for testing
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Stop monitoring to clean up timers
    positionWorkflow.stopPositionMonitoring();
  });

  describe('Event Handler Setup', () => {
    it('should register event handlers during construction', () => {
      expect(mockEventManager.on).toHaveBeenCalledWith('tradeResult', expect.any(Function));
      expect(mockEventManager.on).toHaveBeenCalledWith('positionUpdate', expect.any(Function));
      expect(mockEventManager.on).toHaveBeenCalledWith('exitRequest', expect.any(Function));
    });
  });

  describe('Position Monitoring', () => {
    it('should start position monitoring', async () => {
      mockDbManager.getOpenPositions.mockResolvedValue([]);

      await positionWorkflow.startPositionMonitoring();

      const workflows = positionWorkflow.getActiveWorkflows();
      expect(workflows).toBeDefined();
    });

    it('should stop position monitoring', () => {
      positionWorkflow.stopPositionMonitoring();

      const workflows = positionWorkflow.getActiveWorkflows();
      // All workflows should be marked as stopped
      for (const [, state] of workflows) {
        expect(state.monitoring).toBe('STOPPED');
      }
    });

    it('should evaluate positions for exit conditions', async () => {
      const mockPositions = [
        {
          id: 'position_123',
          tokenAddress: 'token_address',
          entryPrice: 1.0,
          amount: 100,
          openTimestamp: Date.now() - 60000, // 1 minute ago
          entryTradeId: 'trade_123',
          exitStrategy: { type: 'profit', params: { profitPercentage: 50 } },
          status: 'OPEN'
        }
      ];

      const mockPosition = {
        id: 'position_123',
        tokenAddress: 'token_address',
        entryPrice: 1.0,
        amount: 100,
        entryTimestamp: Date.now() - 60000,
        pnlPercent: 0,
        pnlUsd: 0
      };

      const mockExitResult = {
        shouldExit: true,
        reason: 'Profit target reached',
        urgency: 'MEDIUM' as const,
        partialExitPercentage: undefined
      };

      mockDbManager.getOpenPositions.mockResolvedValue(mockPositions as any);
      mockPositionManager.getPosition.mockResolvedValue(mockPosition as any);
      mockPositionManager.evaluateExitConditions.mockReturnValue(mockExitResult);

      await positionWorkflow.startPositionMonitoring();

      // Wait for monitoring cycle to execute
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(mockPositionManager.getPosition).toHaveBeenCalledWith('position_123');
      expect(mockPositionManager.evaluateExitConditions).toHaveBeenCalled();
    });
  });

  describe('New Position Handling', () => {
    it('should handle new position from trade result', async () => {
      const mockTradeResult: TradeResult = {
        success: true,
        signature: 'trade_signature_123',
        tradeId: 'trade_id_123',
        positionId: 'position_id_123',
        timestamp: Date.now()
      };

      const tradeResultHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeResult')?.[1];

      await tradeResultHandler!(mockTradeResult);

      const workflows = positionWorkflow.getActiveWorkflows();
      expect(workflows.has('position_id_123')).toBe(true);

      const workflowState = positionWorkflow.getWorkflowState('position_id_123');
      expect(workflowState?.monitoring).toBe('ACTIVE');
    });

    it('should not create workflow for failed trade result', async () => {
      const mockTradeResult: TradeResult = {
        success: false,
        error: 'Trade failed',
        timestamp: Date.now()
      };

      const tradeResultHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'tradeResult')?.[1];

      await tradeResultHandler!(mockTradeResult);

      const workflows = positionWorkflow.getActiveWorkflows();
      expect(workflows.size).toBe(0);
    });
  });

  describe('Exit Request Handling', () => {
    beforeEach(() => {
      // Create an active position workflow
      (positionWorkflow as any).activePositionWorkflows.set('position_123', {
        monitoring: 'ACTIVE',
        exitEvaluation: 'PENDING',
        exitExecution: 'PENDING'
      });
    });

    it('should process exit request', async () => {
      const exitRequest = {
        positionId: 'position_123',
        reason: 'Manual exit',
        urgency: 'MEDIUM' as const,
        partialExitPercentage: undefined
      };

      mockPositionManager.processExitRequest.mockResolvedValue();

      const exitRequestHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'exitRequest')?.[1];

      await exitRequestHandler!(exitRequest);

      expect(mockPositionManager.processExitRequest).toHaveBeenCalledWith(exitRequest);

      // Workflow should be cleaned up after successful exit
      const workflows = positionWorkflow.getActiveWorkflows();
      expect(workflows.has('position_123')).toBe(false);
    });

    it('should handle exit request failure', async () => {
      const exitRequest = {
        positionId: 'position_123',
        reason: 'Manual exit',
        urgency: 'MEDIUM' as const
      };

      const error = new Error('Exit failed');
      mockPositionManager.processExitRequest.mockRejectedValue(error);

      const exitRequestHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'exitRequest')?.[1];

      await exitRequestHandler!(exitRequest);

      const workflowState = positionWorkflow.getWorkflowState('position_123');
      expect(workflowState?.exitExecution).toBe('FAILED');
    });
  });

  describe('Dry Run Mode', () => {
    let dryRunWorkflow: PositionWorkflowCoordinator;

    beforeEach(() => {
      dryRunWorkflow = new PositionWorkflowCoordinator(
        mockEventManager,
        mockPositionManager,
        mockDbManager,
        true, // dry run mode
        1000
      );
    });

    afterEach(() => {
      dryRunWorkflow.stopPositionMonitoring();
    });

    it('should handle exit request in dry run mode', async () => {
      // Create an active position workflow
      (dryRunWorkflow as any).activePositionWorkflows.set('position_123', {
        monitoring: 'ACTIVE',
        exitEvaluation: 'PENDING',
        exitExecution: 'PENDING'
      });

      const exitRequest = {
        positionId: 'position_123',
        reason: 'Manual exit',
        urgency: 'MEDIUM' as const
      };

      const exitRequestHandler = mockEventManager.on.mock.calls
        .find((call: any) => call[0] === 'exitRequest')?.[1];

      await exitRequestHandler!(exitRequest);

      // Should not call real position manager
      expect(mockPositionManager.processExitRequest).not.toHaveBeenCalled();

      // Workflow should be cleaned up
      const workflows = dryRunWorkflow.getActiveWorkflows();
      expect(workflows.has('position_123')).toBe(false);
    });
  });

  describe('Position State Management', () => {
    it('should pause position monitoring', () => {
      const positionId = 'position_123';
      
      // Create position workflow
      (positionWorkflow as any).activePositionWorkflows.set(positionId, {
        monitoring: 'ACTIVE',
        exitEvaluation: 'PENDING',
        exitExecution: 'PENDING'
      });

      positionWorkflow.pausePositionMonitoring(positionId);

      const workflowState = positionWorkflow.getWorkflowState(positionId);
      expect(workflowState?.monitoring).toBe('PAUSED');
    });

    it('should resume position monitoring', () => {
      const positionId = 'position_123';
      
      // Create paused position workflow
      (positionWorkflow as any).activePositionWorkflows.set(positionId, {
        monitoring: 'PAUSED',
        exitEvaluation: 'PENDING',
        exitExecution: 'PENDING'
      });

      positionWorkflow.resumePositionMonitoring(positionId);

      const workflowState = positionWorkflow.getWorkflowState(positionId);
      expect(workflowState?.monitoring).toBe('ACTIVE');
    });

    it('should provide access to workflow states', () => {
      const positionId = 'position_123';
      const mockState = {
        monitoring: 'ACTIVE' as const,
        exitEvaluation: 'COMPLETED' as const,
        exitExecution: 'PENDING' as const
      };

      (positionWorkflow as any).activePositionWorkflows.set(positionId, mockState);

      const retrievedState = positionWorkflow.getWorkflowState(positionId);
      expect(retrievedState).toEqual(mockState);

      const allWorkflows = positionWorkflow.getActiveWorkflows();
      expect(allWorkflows.get(positionId)).toEqual(mockState);
    });

    it('should return null for non-existent position workflow', () => {
      const state = positionWorkflow.getWorkflowState('non_existent');
      expect(state).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should handle position evaluation errors gracefully', async () => {
      const mockPositions = [
        {
          id: 'position_123',
          tokenAddress: 'token_address',
          entryPrice: 1.0,
          amount: 100,
          openTimestamp: Date.now() - 60000,
          entryTradeId: 'trade_123',
          exitStrategy: { type: 'profit', params: { profitPercentage: 50 } },
          status: 'OPEN'
        }
      ];

      const error = new Error('Position not found');

      mockDbManager.getOpenPositions.mockResolvedValue(mockPositions as any);
      mockPositionManager.getPosition.mockRejectedValue(error);

      await positionWorkflow.startPositionMonitoring();

      // Wait for monitoring cycle to execute
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should handle the error gracefully and continue monitoring
      expect(mockPositionManager.getPosition).toHaveBeenCalled();
    });

    it('should handle database errors in monitoring cycle', async () => {
      const error = new Error('Database connection failed');
      mockDbManager.getOpenPositions.mockRejectedValue(error);

      await positionWorkflow.startPositionMonitoring();

      // Wait for monitoring cycle to execute
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should handle the error gracefully
      expect(mockDbManager.getOpenPositions).toHaveBeenCalled();
    });
  });
});