// No need to import from @jest/globals - Jest globals are available by default
import { 
  TradingStateMachine, 
  TradingState, 
  TradingStateTransition 
} from '../../src/core/state-machines/trading-state-machine';

describe('TradingStateMachine', () => {
  let stateMachine: TradingStateMachine;

  beforeEach(() => {
    stateMachine = new TradingStateMachine();
  });

  describe('Initial State', () => {
    it('should start in IDLE state', () => {
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });

    it('should have empty context initially', () => {
      const context = stateMachine.getContext();
      expect(Object.keys(context)).toHaveLength(0);
    });

    it('should record initial state in history', () => {
      const history = stateMachine.getStateHistory();
      expect(history).toHaveLength(1);
      expect(history[0].state).toBe(TradingState.IDLE);
    });
  });

  describe('Valid State Transitions', () => {
    it('should transition from IDLE to EVALUATING_POOL on POOL_DETECTED', () => {
      const success = stateMachine.transition(TradingStateTransition.POOL_DETECTED, {
        poolAddress: 'test_pool',
        tokenAddress: 'test_token'
      });

      expect(success).toBe(true);
      expect(stateMachine.getCurrentState()).toBe(TradingState.EVALUATING_POOL);
      
      const context = stateMachine.getContext();
      expect(context.poolAddress).toBe('test_pool');
      expect(context.tokenAddress).toBe('test_token');
      expect(context.startTime).toBeDefined();
    });

    it('should transition from EVALUATING_POOL to PREPARING_TRADE on successful evaluation', () => {
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      
      const success = stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });

      expect(success).toBe(true);
      expect(stateMachine.getCurrentState()).toBe(TradingState.PREPARING_TRADE);
    });

    it('should transition from EVALUATING_POOL to IDLE when no trade is recommended', () => {
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      
      const success = stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED);

      expect(success).toBe(true);
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });

    it('should transition through complete successful trading flow', () => {
      // IDLE -> EVALUATING_POOL
      stateMachine.transition(TradingStateTransition.POOL_DETECTED, {
        poolAddress: 'test_pool',
        tokenAddress: 'test_token'
      });
      expect(stateMachine.getCurrentState()).toBe(TradingState.EVALUATING_POOL);

      // EVALUATING_POOL -> PREPARING_TRADE
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });
      expect(stateMachine.getCurrentState()).toBe(TradingState.PREPARING_TRADE);

      // PREPARING_TRADE -> EXECUTING_TRADE
      stateMachine.transition(TradingStateTransition.TRADE_PREPARED);
      expect(stateMachine.getCurrentState()).toBe(TradingState.EXECUTING_TRADE);

      // EXECUTING_TRADE -> CONFIRMING_TRADE
      stateMachine.transition(TradingStateTransition.TRADE_SUBMITTED, {
        transactionSignature: 'test_signature'
      });
      expect(stateMachine.getCurrentState()).toBe(TradingState.CONFIRMING_TRADE);

      // CONFIRMING_TRADE -> TRADE_COMPLETED
      stateMachine.transition(TradingStateTransition.TRADE_CONFIRMED);
      expect(stateMachine.getCurrentState()).toBe(TradingState.TRADE_COMPLETED);

      // TRADE_COMPLETED -> IDLE
      stateMachine.transition(TradingStateTransition.RESET);
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });
  });

  describe('Invalid State Transitions', () => {
    it('should reject invalid transitions', () => {
      // Try to go directly from IDLE to EXECUTING_TRADE
      const success = stateMachine.transition(TradingStateTransition.TRADE_SUBMITTED);
      
      expect(success).toBe(false);
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });

    it('should reject transitions without required context', () => {
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      
      // Try to transition to PREPARING_TRADE without token address
      const success = stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tradeAmount: 100
        // missing tokenAddress
      });
      
      expect(success).toBe(false);
      expect(stateMachine.getCurrentState()).toBe(TradingState.EVALUATING_POOL);
    });
  });

  describe('Error Handling', () => {
    it('should transition to ERROR state from any state', () => {
      // Start a trading flow
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });

      expect(stateMachine.getCurrentState()).toBe(TradingState.PREPARING_TRADE);

      // Trigger error
      const success = stateMachine.transition(TradingStateTransition.ERROR_OCCURRED, {
        error: new Error('Something went wrong')
      });

      expect(success).toBe(true);
      expect(stateMachine.getCurrentState()).toBe(TradingState.ERROR);
    });

    it('should reset from ERROR state to IDLE', () => {
      stateMachine.transition(TradingStateTransition.ERROR_OCCURRED);
      expect(stateMachine.getCurrentState()).toBe(TradingState.ERROR);

      stateMachine.transition(TradingStateTransition.RESET);
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });
  });

  describe('State Queries', () => {
    it('should correctly identify terminal states', () => {
      expect(stateMachine.isTerminalState()).toBe(false); // IDLE is not terminal

      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });
      stateMachine.transition(TradingStateTransition.TRADE_PREPARED);
      stateMachine.transition(TradingStateTransition.TRADE_SUBMITTED);
      stateMachine.transition(TradingStateTransition.TRADE_CONFIRMED);

      expect(stateMachine.isTerminalState()).toBe(true); // TRADE_COMPLETED is terminal
    });

    it('should correctly identify processing states', () => {
      expect(stateMachine.isProcessingTrade()).toBe(false); // IDLE is not processing

      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      expect(stateMachine.isProcessingTrade()).toBe(true); // EVALUATING_POOL is processing

      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });
      expect(stateMachine.isProcessingTrade()).toBe(true); // PREPARING_TRADE is processing
    });

    it('should check if specific transitions are valid', () => {
      expect(stateMachine.canTransition(TradingStateTransition.POOL_DETECTED)).toBe(true);
      expect(stateMachine.canTransition(TradingStateTransition.TRADE_SUBMITTED)).toBe(false);

      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      expect(stateMachine.canTransition(TradingStateTransition.EVALUATION_COMPLETED)).toBe(true);
      expect(stateMachine.canTransition(TradingStateTransition.POOL_DETECTED)).toBe(false);
    });
  });

  describe('Context Management', () => {
    it('should update context during transitions', () => {
      stateMachine.transition(TradingStateTransition.POOL_DETECTED, {
        poolAddress: 'test_pool',
        tokenAddress: 'test_token'
      });

      const context = stateMachine.getContext();
      expect(context.poolAddress).toBe('test_pool');
      expect(context.tokenAddress).toBe('test_token');
      expect(context.startTime).toBeDefined();
      expect(context.lastTransition).toBeDefined();
    });

    it('should reset context when returning to IDLE', () => {
      // Start and complete a trading flow
      stateMachine.transition(TradingStateTransition.POOL_DETECTED, {
        poolAddress: 'test_pool',
        tokenAddress: 'test_token'
      });
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });
      stateMachine.transition(TradingStateTransition.TRADE_PREPARED);
      stateMachine.transition(TradingStateTransition.TRADE_SUBMITTED);
      stateMachine.transition(TradingStateTransition.TRADE_CONFIRMED);
      
      // Reset to IDLE
      stateMachine.transition(TradingStateTransition.RESET);

      const context = stateMachine.getContext();
      expect(Object.keys(context)).toHaveLength(0);
    });
  });

  describe('State History', () => {
    it('should maintain state history', () => {
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });

      const history = stateMachine.getStateHistory();
      expect(history).toHaveLength(3); // IDLE + 2 transitions
      expect(history[1].state).toBe(TradingState.EVALUATING_POOL);
      expect(history[1].trigger).toBe(TradingStateTransition.POOL_DETECTED);
      expect(history[2].state).toBe(TradingState.PREPARING_TRADE);
      expect(history[2].trigger).toBe(TradingStateTransition.EVALUATION_COMPLETED);
    });

    it('should calculate state duration', () => {
      const duration1 = stateMachine.getStateDuration();
      expect(duration1).toBeGreaterThanOrEqual(0);

      // Wait a bit and check duration increased
      setTimeout(() => {
        const duration2 = stateMachine.getStateDuration();
        expect(duration2).toBeGreaterThan(duration1);
      }, 10);
    });

    it('should limit history size to prevent memory leaks', () => {
      // Create more than 100 state changes
      for (let i = 0; i < 110; i++) {
        stateMachine.transition(TradingStateTransition.POOL_DETECTED);
        stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED);
      }

      const history = stateMachine.getStateHistory();
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Force State Changes', () => {
    it('should allow force state changes', () => {
      stateMachine.forceState(TradingState.EXECUTING_TRADE, 'Testing force state');
      
      expect(stateMachine.getCurrentState()).toBe(TradingState.EXECUTING_TRADE);
      
      const history = stateMachine.getStateHistory();
      expect(history[history.length - 1].state).toBe(TradingState.EXECUTING_TRADE);
    });
  });

  describe('Reset Functionality', () => {
    it('should provide reset method', () => {
      // Start a trading flow
      stateMachine.transition(TradingStateTransition.POOL_DETECTED);
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
        tokenAddress: 'test_token',
        tradeAmount: 100
      });

      expect(stateMachine.getCurrentState()).toBe(TradingState.PREPARING_TRADE);

      // Reset
      stateMachine.reset();
      expect(stateMachine.getCurrentState()).toBe(TradingState.IDLE);
    });
  });
});