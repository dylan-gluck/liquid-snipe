/**
 * AtomicCompatibilityWrapper - Backward compatibility layer
 * Provides synchronous interface for AtomicPositionStateMachine
 * 
 * Allows existing code to work unchanged while using atomic operations internally
 */

import { AtomicPositionStateMachine } from './atomic-position-state-machine';
import {
  PositionState,
  PositionStateTransition,
  PositionStateContext,
} from './position-state-machine';
import { Logger } from '../../utils/logger';

/**
 * Compatibility wrapper that maintains synchronous API while using atomic operations
 */
export class CompatibleAtomicPositionStateMachine {
  private atomicStateMachine: AtomicPositionStateMachine;
  private logger: Logger;
  private lastKnownContext: PositionStateContext;

  constructor(initialContext: Omit<PositionStateContext, 'entryTimestamp'>) {
    this.atomicStateMachine = new AtomicPositionStateMachine(initialContext);
    this.logger = new Logger(`CompatibleAtomic:${initialContext.positionId}`);
    this.lastKnownContext = { ...initialContext, entryTimestamp: Date.now() };
    
    // Initialize cached context
    this.updateCachedContext();
  }

  /**
   * Synchronous transition - maintains backward compatibility
   * Uses async operations internally but provides sync interface
   */
  public transition(
    trigger: PositionStateTransition,
    contextUpdates?: Partial<PositionStateContext>
  ): boolean {
    // Use cached result pattern for synchronous interface
    let result = false;
    
    // Execute atomic transition asynchronously but return immediately
    this.atomicStateMachine.transition(trigger, contextUpdates)
      .then((success) => {
        result = success;
        if (success) {
          this.updateCachedContext();
        }
      })
      .catch((error) => {
        this.logger.error(`Atomic transition failed: ${error.message}`);
        result = false;
      });

    // For immediate synchronous response, check if transition is valid
    const currentState = this.getCurrentState();
    const canTransition = this.atomicStateMachine.canTransition(trigger);
    
    if (canTransition) {
      // Update cached context immediately for backward compatibility
      if (contextUpdates) {
        this.lastKnownContext = { ...this.lastKnownContext, ...contextUpdates };
      }
    }
    
    return canTransition;
  }

  /**
   * Synchronous price update with atomic operations
   */
  public updatePrice(currentPrice: number): void {
    // Calculate PnL immediately for sync response
    if (this.lastKnownContext.entryPrice) {
      this.lastKnownContext.currentPrice = currentPrice;
      this.lastKnownContext.lastPriceUpdate = Date.now();
      this.lastKnownContext.pnlPercent = 
        ((currentPrice - this.lastKnownContext.entryPrice) / this.lastKnownContext.entryPrice) * 100;
      this.lastKnownContext.pnlUsd = 
        (currentPrice - this.lastKnownContext.entryPrice) * this.lastKnownContext.amount;
    }

    // Execute atomic update asynchronously
    this.atomicStateMachine.updatePrice(currentPrice)
      .then(() => this.updateCachedContext())
      .catch((error) => {
        this.logger.error(`Atomic price update failed: ${error.message}`);
      });
  }

  public getCurrentState(): PositionState {
    return this.atomicStateMachine.getCurrentState();
  }

  public getContext(): PositionStateContext {
    return { ...this.lastKnownContext };
  }

  public getStateHistory(): Array<{
    state: PositionState;
    timestamp: number;
    trigger?: PositionStateTransition;
  }> {
    return this.atomicStateMachine.getStateHistory();
  }

  public isInState(state: PositionState): boolean {
    return this.atomicStateMachine.isInState(state);
  }

  public isClosed(): boolean {
    return this.atomicStateMachine.isClosed();
  }

  public isActive(): boolean {
    return this.atomicStateMachine.isActive();
  }

  public isPaused(): boolean {
    return this.atomicStateMachine.isPaused();
  }

  public hasError(): boolean {
    return this.atomicStateMachine.hasError();
  }

  public canExit(): boolean {
    return this.atomicStateMachine.canExit();
  }

  public canPause(): boolean {
    return this.atomicStateMachine.canPause();
  }

  public canResume(): boolean {
    return this.atomicStateMachine.canResume();
  }

  public getPositionAge(): number {
    return Date.now() - this.lastKnownContext.entryTimestamp;
  }

  public getTimeInCurrentState(): number {
    return this.atomicStateMachine.getTimeInCurrentState();
  }

  public getTimeSinceLastPriceUpdate(): number {
    return this.lastKnownContext.lastPriceUpdate ? 
      Date.now() - this.lastKnownContext.lastPriceUpdate : Infinity;
  }

  public getPnL(): { percent: number; usd: number } {
    return {
      percent: this.lastKnownContext.pnlPercent || 0,
      usd: this.lastKnownContext.pnlUsd || 0,
    };
  }

  public forceState(state: PositionState, reason: string): void {
    this.atomicStateMachine.forceState(state, reason);
    this.updateCachedContext();
  }

  public canTransition(trigger: PositionStateTransition): boolean {
    return this.atomicStateMachine.canTransition(trigger);
  }

  /**
   * Access to atomic performance metrics
   */
  public getAtomicMetrics() {
    return this.atomicStateMachine.getPerformanceMetrics();
  }

  /**
   * Get the underlying atomic state machine for advanced operations
   */
  public getAtomicStateMachine(): AtomicPositionStateMachine {
    return this.atomicStateMachine;
  }

  private updateCachedContext(): void {
    this.atomicStateMachine.getContext()
      .then((context) => {
        this.lastKnownContext = context;
      })
      .catch((error) => {
        this.logger.error(`Failed to update cached context: ${error.message}`);
      });
  }
}

/**
 * Factory function for creating compatible atomic position state machines
 */
export function createAtomicPositionStateMachine(
  initialContext: Omit<PositionStateContext, 'entryTimestamp'>,
  useAtomicImplementation = true
): CompatibleAtomicPositionStateMachine {
  if (!useAtomicImplementation) {
    // Fallback to original implementation if needed
    throw new Error('Non-atomic fallback not implemented in this version');
  }
  
  return new CompatibleAtomicPositionStateMachine(initialContext);
}