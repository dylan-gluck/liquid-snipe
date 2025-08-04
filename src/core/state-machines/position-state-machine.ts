import { Logger } from '../../utils/logger';

export enum PositionState {
  CREATED = 'CREATED',
  MONITORING = 'MONITORING',
  EXIT_PENDING = 'EXIT_PENDING',
  EXITING = 'EXITING',
  CLOSED = 'CLOSED',
  ERROR = 'ERROR',
  PAUSED = 'PAUSED'
}

export enum PositionStateTransition {
  POSITION_OPENED = 'POSITION_OPENED',
  MONITORING_STARTED = 'MONITORING_STARTED',
  EXIT_CONDITION_MET = 'EXIT_CONDITION_MET',
  MANUAL_EXIT_REQUESTED = 'MANUAL_EXIT_REQUESTED',
  EXIT_APPROVED = 'EXIT_APPROVED',
  EXIT_REJECTED = 'EXIT_REJECTED',
  EXIT_STARTED = 'EXIT_STARTED',
  EXIT_COMPLETED = 'EXIT_COMPLETED',
  EXIT_FAILED = 'EXIT_FAILED',
  PAUSE_REQUESTED = 'PAUSE_REQUESTED',
  RESUME_REQUESTED = 'RESUME_REQUESTED',
  ERROR_OCCURRED = 'ERROR_OCCURRED',
  RECOVERY_COMPLETED = 'RECOVERY_COMPLETED'
}

export interface PositionStateContext {
  positionId: string;
  tokenAddress: string;
  entryPrice: number;
  currentPrice?: number;
  amount: number;
  entryTimestamp: number;
  exitReason?: string;
  exitTimestamp?: number;
  pnlPercent?: number;
  pnlUsd?: number;
  error?: Error;
  lastPriceUpdate?: number;
  exitStrategy?: string;
}

export interface PositionStateTransitionRule {
  from: PositionState;
  to: PositionState;
  trigger: PositionStateTransition;
  guard?: (context: PositionStateContext) => boolean;
  action?: (context: PositionStateContext) => void;
}

export class PositionStateMachine {
  private logger: Logger;
  private currentState: PositionState = PositionState.CREATED;
  private context: PositionStateContext;
  private transitionRules: PositionStateTransitionRule[];
  private stateHistory: Array<{ state: PositionState; timestamp: number; trigger?: PositionStateTransition }> = [];

  constructor(initialContext: Omit<PositionStateContext, 'entryTimestamp'>) {
    this.logger = new Logger(`PositionStateMachine:${initialContext.positionId}`);
    this.context = {
      ...initialContext,
      entryTimestamp: Date.now()
    };
    this.transitionRules = this.initializeTransitionRules();
    this.recordStateChange(PositionState.CREATED);
  }

  private initializeTransitionRules(): PositionStateTransitionRule[] {
    return [
      // From CREATED
      {
        from: PositionState.CREATED,
        to: PositionState.MONITORING,
        trigger: PositionStateTransition.POSITION_OPENED,
        action: (context) => {
          this.logger.info(`Position ${context.positionId} opened, starting monitoring`);
        }
      },

      // From MONITORING
      {
        from: PositionState.MONITORING,
        to: PositionState.EXIT_PENDING,
        trigger: PositionStateTransition.EXIT_CONDITION_MET,
        action: (context) => {
          this.logger.info(`Exit condition met for position ${context.positionId}: ${context.exitReason}`);
        }
      },
      {
        from: PositionState.MONITORING,
        to: PositionState.EXIT_PENDING,
        trigger: PositionStateTransition.MANUAL_EXIT_REQUESTED,
        action: (context) => {
          this.logger.info(`Manual exit requested for position ${context.positionId}`);
        }
      },
      {
        from: PositionState.MONITORING,
        to: PositionState.PAUSED,
        trigger: PositionStateTransition.PAUSE_REQUESTED,
        action: (context) => {
          this.logger.info(`Position monitoring paused for ${context.positionId}`);
        }
      },

      // From EXIT_PENDING
      {
        from: PositionState.EXIT_PENDING,
        to: PositionState.EXITING,
        trigger: PositionStateTransition.EXIT_APPROVED,
        action: (context) => {
          this.logger.info(`Exit approved for position ${context.positionId}, starting exit process`);
        }
      },
      {
        from: PositionState.EXIT_PENDING,
        to: PositionState.MONITORING,
        trigger: PositionStateTransition.EXIT_REJECTED,
        action: (context) => {
          this.logger.info(`Exit rejected for position ${context.positionId}, resuming monitoring`);
        }
      },

      // From EXITING
      {
        from: PositionState.EXITING,
        to: PositionState.CLOSED,
        trigger: PositionStateTransition.EXIT_COMPLETED,
        action: (context) => {
          context.exitTimestamp = Date.now();
          const duration = context.exitTimestamp - context.entryTimestamp;
          this.logger.info(`Position ${context.positionId} closed after ${duration}ms`);
          
          if (context.currentPrice && context.entryPrice) {
            context.pnlPercent = ((context.currentPrice - context.entryPrice) / context.entryPrice) * 100;
            context.pnlUsd = (context.currentPrice - context.entryPrice) * context.amount;
          }
        }
      },
      {
        from: PositionState.EXITING,
        to: PositionState.ERROR,
        trigger: PositionStateTransition.EXIT_FAILED,
        action: (context) => {
          this.logger.error(`Position exit failed for ${context.positionId}: ${context.error?.message}`);
        }
      },

      // From PAUSED
      {
        from: PositionState.PAUSED,
        to: PositionState.MONITORING,
        trigger: PositionStateTransition.RESUME_REQUESTED,
        action: (context) => {
          this.logger.info(`Position monitoring resumed for ${context.positionId}`);
        }
      },
      {
        from: PositionState.PAUSED,
        to: PositionState.EXIT_PENDING,
        trigger: PositionStateTransition.MANUAL_EXIT_REQUESTED,
        action: (context) => {
          this.logger.info(`Manual exit requested for paused position ${context.positionId}`);
        }
      },

      // From ERROR
      {
        from: PositionState.ERROR,
        to: PositionState.MONITORING,
        trigger: PositionStateTransition.RECOVERY_COMPLETED,
        action: (context) => {
          this.logger.info(`Recovery completed for position ${context.positionId}, resuming monitoring`);
        }
      },
      {
        from: PositionState.ERROR,
        to: PositionState.CLOSED,
        trigger: PositionStateTransition.EXIT_COMPLETED,
        action: (context) => {
          this.logger.info(`Position ${context.positionId} force-closed due to error`);
          context.exitTimestamp = Date.now();
          context.exitReason = context.exitReason || 'Force closed due to error';
        }
      },

      // Error transitions from any state except CLOSED
      ...Object.values(PositionState)
        .filter(state => state !== PositionState.ERROR && state !== PositionState.CLOSED)
        .map(state => ({
          from: state,
          to: PositionState.ERROR,
          trigger: PositionStateTransition.ERROR_OCCURRED,
          action: (context) => {
            this.logger.error(`Position ${context.positionId} encountered error: ${context.error?.message}`);
          }
        }))
    ];
  }

  public transition(trigger: PositionStateTransition, contextUpdates?: Partial<PositionStateContext>): boolean {
    // Update context if provided
    if (contextUpdates) {
      this.context = { ...this.context, ...contextUpdates };
    }

    // Find applicable transition rule
    const rule = this.transitionRules.find(r => 
      r.from === this.currentState && 
      r.trigger === trigger &&
      (!r.guard || r.guard(this.context))
    );

    if (!rule) {
      this.logger.warning(`No valid transition from ${this.currentState} with trigger ${trigger}`);
      return false;
    }

    // Execute transition
    const previousState = this.currentState;
    this.currentState = rule.to;

    // Execute action if defined
    if (rule.action) {
      try {
        rule.action(this.context);
      } catch (error) {
        this.logger.error(`State action failed: ${(error as Error).message}`);
      }
    }

    // Record state change
    this.recordStateChange(this.currentState, trigger);

    this.logger.debug(`State transition: ${previousState} → ${this.currentState} (${trigger})`);
    return true;
  }

  public updatePrice(currentPrice: number): void {
    this.context.currentPrice = currentPrice;
    this.context.lastPriceUpdate = Date.now();
    
    // Calculate P&L
    if (this.context.entryPrice) {
      this.context.pnlPercent = ((currentPrice - this.context.entryPrice) / this.context.entryPrice) * 100;
      this.context.pnlUsd = (currentPrice - this.context.entryPrice) * this.context.amount;
    }
  }

  public getCurrentState(): PositionState {
    return this.currentState;
  }

  public getContext(): PositionStateContext {
    return { ...this.context };
  }

  public getStateHistory(): Array<{ state: PositionState; timestamp: number; trigger?: PositionStateTransition }> {
    return [...this.stateHistory];
  }

  public isInState(state: PositionState): boolean {
    return this.currentState === state;
  }

  public isClosed(): boolean {
    return this.currentState === PositionState.CLOSED;
  }

  public isActive(): boolean {
    return [
      PositionState.MONITORING,
      PositionState.EXIT_PENDING,
      PositionState.EXITING
    ].includes(this.currentState);
  }

  public isPaused(): boolean {
    return this.currentState === PositionState.PAUSED;
  }

  public hasError(): boolean {
    return this.currentState === PositionState.ERROR;
  }

  public canExit(): boolean {
    return [
      PositionState.MONITORING,
      PositionState.PAUSED,
      PositionState.ERROR
    ].includes(this.currentState);
  }

  public canPause(): boolean {
    return this.currentState === PositionState.MONITORING;
  }

  public canResume(): boolean {
    return this.currentState === PositionState.PAUSED;
  }

  public getPositionAge(): number {
    return Date.now() - this.context.entryTimestamp;
  }

  public getTimeInCurrentState(): number {
    const lastChange = this.stateHistory[this.stateHistory.length - 1];
    return lastChange ? Date.now() - lastChange.timestamp : 0;
  }

  public getTimeSinceLastPriceUpdate(): number {
    return this.context.lastPriceUpdate ? Date.now() - this.context.lastPriceUpdate : Infinity;
  }

  public getPnL(): { percent: number; usd: number } {
    return {
      percent: this.context.pnlPercent || 0,
      usd: this.context.pnlUsd || 0
    };
  }

  public forceState(state: PositionState, reason: string): void {
    this.logger.warning(`Force state change to ${state}: ${reason}`);
    const previousState = this.currentState;
    this.currentState = state;
    this.recordStateChange(state);
    this.logger.debug(`Forced state change: ${previousState} → ${state}`);
  }

  private recordStateChange(state: PositionState, trigger?: PositionStateTransition): void {
    this.stateHistory.push({
      state,
      timestamp: Date.now(),
      trigger
    });

    // Keep only last 50 state changes per position
    if (this.stateHistory.length > 50) {
      this.stateHistory = this.stateHistory.slice(-50);
    }
  }

  public canTransition(trigger: PositionStateTransition): boolean {
    return this.transitionRules.some(r => 
      r.from === this.currentState && 
      r.trigger === trigger &&
      (!r.guard || r.guard(this.context))
    );
  }
}