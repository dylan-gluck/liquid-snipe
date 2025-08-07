/**
 * Basic Atomic Position State Machine Test
 * Simple validation of core atomic functionality
 */

import { AtomicPositionStateMachine } from '../src/core/state-machines/atomic-position-state-machine';
import { PositionState, PositionStateTransition } from '../src/core/state-machines/position-state-machine';

describe('Basic Atomic Position State Machine', () => {
  it('should create atomic position state machine', () => {
    const initialContext = {
      positionId: 'test-pos-1',
      tokenAddress: 'test-token',
      entryPrice: 100,
      amount: 1000,
    };

    const stateMachine = new AtomicPositionStateMachine(initialContext);
    expect(stateMachine).toBeDefined();
    expect(stateMachine.getCurrentState()).toBe(PositionState.CREATED);
  });

  it('should handle basic state transitions', async () => {
    const initialContext = {
      positionId: 'test-pos-2',
      tokenAddress: 'test-token',
      entryPrice: 100,
      amount: 1000,
    };

    const stateMachine = new AtomicPositionStateMachine(initialContext);
    
    // Transition from CREATED to MONITORING
    const transitionResult = await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
    
    expect(transitionResult).toBe(true);
    expect(stateMachine.getCurrentState()).toBe(PositionState.MONITORING);
    expect(stateMachine.isActive()).toBe(true);
  });

  it('should handle price updates', async () => {
    const initialContext = {
      positionId: 'test-pos-3',
      tokenAddress: 'test-token',
      entryPrice: 100,
      amount: 1000,
    };

    const stateMachine = new AtomicPositionStateMachine(initialContext);
    await stateMachine.transition(PositionStateTransition.POSITION_OPENED);
    
    // Update price
    await stateMachine.updatePrice(110);
    
    const context = await stateMachine.getContext();
    expect(context.currentPrice).toBe(110);
    expect(context.pnlPercent).toBeCloseTo(10); // 10% gain
  });
});