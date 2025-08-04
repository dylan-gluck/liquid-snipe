import { Logger } from '../../utils/logger';

export enum TradingState {
  IDLE = 'IDLE',
  EVALUATING_POOL = 'EVALUATING_POOL',
  PREPARING_TRADE = 'PREPARING_TRADE',
  EXECUTING_TRADE = 'EXECUTING_TRADE',
  CONFIRMING_TRADE = 'CONFIRMING_TRADE',
  TRADE_COMPLETED = 'TRADE_COMPLETED',
  TRADE_FAILED = 'TRADE_FAILED',
  ERROR = 'ERROR',
}

export enum TradingStateTransition {
  POOL_DETECTED = 'POOL_DETECTED',
  EVALUATION_COMPLETED = 'EVALUATION_COMPLETED',
  EVALUATION_FAILED = 'EVALUATION_FAILED',
  TRADE_APPROVED = 'TRADE_APPROVED',
  TRADE_REJECTED = 'TRADE_REJECTED',
  TRADE_PREPARED = 'TRADE_PREPARED',
  TRADE_PREPARATION_FAILED = 'TRADE_PREPARATION_FAILED',
  TRADE_SUBMITTED = 'TRADE_SUBMITTED',
  TRADE_SUBMISSION_FAILED = 'TRADE_SUBMISSION_FAILED',
  TRADE_CONFIRMED = 'TRADE_CONFIRMED',
  TRADE_CONFIRMATION_FAILED = 'TRADE_CONFIRMATION_FAILED',
  TRADE_TIMEOUT = 'TRADE_TIMEOUT',
  RESET = 'RESET',
  ERROR_OCCURRED = 'ERROR_OCCURRED',
}

export interface TradingStateContext {
  poolAddress?: string;
  tokenAddress?: string;
  tradeAmount?: number;
  transactionSignature?: string;
  error?: Error;
  startTime?: number;
  lastTransition?: number;
}

export interface TradingStateTransitionRule {
  from: TradingState;
  to: TradingState;
  trigger: TradingStateTransition;
  guard?: (context: TradingStateContext) => boolean;
  action?: (context: TradingStateContext) => void;
}

export class TradingStateMachine {
  private logger: Logger;
  private currentState: TradingState = TradingState.IDLE;
  private context: TradingStateContext = {};
  private transitionRules: TradingStateTransitionRule[];
  private stateHistory: Array<{
    state: TradingState;
    timestamp: number;
    trigger?: TradingStateTransition;
  }> = [];

  constructor() {
    this.logger = new Logger('TradingStateMachine');
    this.transitionRules = this.initializeTransitionRules();
    this.recordStateChange(TradingState.IDLE);
  }

  private initializeTransitionRules(): TradingStateTransitionRule[] {
    return [
      // From IDLE
      {
        from: TradingState.IDLE,
        to: TradingState.EVALUATING_POOL,
        trigger: TradingStateTransition.POOL_DETECTED,
        action: context => {
          context.startTime = Date.now();
        },
      },

      // From EVALUATING_POOL
      {
        from: TradingState.EVALUATING_POOL,
        to: TradingState.PREPARING_TRADE,
        trigger: TradingStateTransition.EVALUATION_COMPLETED,
        guard: context => Boolean(context.tokenAddress && context.tradeAmount),
      },
      {
        from: TradingState.EVALUATING_POOL,
        to: TradingState.IDLE,
        trigger: TradingStateTransition.EVALUATION_COMPLETED,
        guard: context => !context.tokenAddress || !context.tradeAmount,
      },
      {
        from: TradingState.EVALUATING_POOL,
        to: TradingState.ERROR,
        trigger: TradingStateTransition.EVALUATION_FAILED,
      },

      // From PREPARING_TRADE
      {
        from: TradingState.PREPARING_TRADE,
        to: TradingState.EXECUTING_TRADE,
        trigger: TradingStateTransition.TRADE_PREPARED,
      },
      {
        from: TradingState.PREPARING_TRADE,
        to: TradingState.TRADE_FAILED,
        trigger: TradingStateTransition.TRADE_PREPARATION_FAILED,
      },
      {
        from: TradingState.PREPARING_TRADE,
        to: TradingState.IDLE,
        trigger: TradingStateTransition.TRADE_REJECTED,
      },

      // From EXECUTING_TRADE
      {
        from: TradingState.EXECUTING_TRADE,
        to: TradingState.CONFIRMING_TRADE,
        trigger: TradingStateTransition.TRADE_SUBMITTED,
        action: context => {
          // Transaction submitted, now waiting for confirmation
        },
      },
      {
        from: TradingState.EXECUTING_TRADE,
        to: TradingState.TRADE_FAILED,
        trigger: TradingStateTransition.TRADE_SUBMISSION_FAILED,
      },

      // From CONFIRMING_TRADE
      {
        from: TradingState.CONFIRMING_TRADE,
        to: TradingState.TRADE_COMPLETED,
        trigger: TradingStateTransition.TRADE_CONFIRMED,
        action: context => {
          // Trade successfully completed
          this.logger.info(`Trade completed: ${context.transactionSignature}`);
        },
      },
      {
        from: TradingState.CONFIRMING_TRADE,
        to: TradingState.TRADE_FAILED,
        trigger: TradingStateTransition.TRADE_CONFIRMATION_FAILED,
      },
      {
        from: TradingState.CONFIRMING_TRADE,
        to: TradingState.TRADE_FAILED,
        trigger: TradingStateTransition.TRADE_TIMEOUT,
      },

      // From terminal states back to IDLE
      {
        from: TradingState.TRADE_COMPLETED,
        to: TradingState.IDLE,
        trigger: TradingStateTransition.RESET,
        action: context => {
          // Clear context for next trade
          const duration = context.startTime ? Date.now() - context.startTime : 0;
          this.logger.info(`Trading cycle completed in ${duration}ms`);
          this.resetContext();
        },
      },
      {
        from: TradingState.TRADE_FAILED,
        to: TradingState.IDLE,
        trigger: TradingStateTransition.RESET,
        action: context => {
          this.logger.warning(`Trading cycle failed: ${context.error?.message}`);
          this.resetContext();
        },
      },
      {
        from: TradingState.ERROR,
        to: TradingState.IDLE,
        trigger: TradingStateTransition.RESET,
        action: context => {
          this.logger.error(`Trading state machine error: ${context.error?.message}`);
          this.resetContext();
        },
      },

      // Error transitions from any state
      ...Object.values(TradingState).map(state => ({
        from: state,
        to: TradingState.ERROR,
        trigger: TradingStateTransition.ERROR_OCCURRED,
      })),
    ];
  }

  public transition(
    trigger: TradingStateTransition,
    contextUpdates?: Partial<TradingStateContext>,
  ): boolean {
    // Update context if provided
    if (contextUpdates) {
      this.context = { ...this.context, ...contextUpdates };
    }

    // Find applicable transition rule
    const rule = this.transitionRules.find(
      r =>
        r.from === this.currentState &&
        r.trigger === trigger &&
        (!r.guard || r.guard(this.context)),
    );

    if (!rule) {
      this.logger.warning(`No valid transition from ${this.currentState} with trigger ${trigger}`);
      return false;
    }

    // Execute transition
    const previousState = this.currentState;
    this.currentState = rule.to;
    this.context.lastTransition = Date.now();

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

  public getCurrentState(): TradingState {
    return this.currentState;
  }

  public getContext(): TradingStateContext {
    return { ...this.context };
  }

  public getStateHistory(): Array<{
    state: TradingState;
    timestamp: number;
    trigger?: TradingStateTransition;
  }> {
    return [...this.stateHistory];
  }

  public isInState(state: TradingState): boolean {
    return this.currentState === state;
  }

  public isTerminalState(): boolean {
    return [TradingState.TRADE_COMPLETED, TradingState.TRADE_FAILED, TradingState.ERROR].includes(
      this.currentState,
    );
  }

  public isProcessingTrade(): boolean {
    return [
      TradingState.EVALUATING_POOL,
      TradingState.PREPARING_TRADE,
      TradingState.EXECUTING_TRADE,
      TradingState.CONFIRMING_TRADE,
    ].includes(this.currentState);
  }

  public reset(): void {
    this.transition(TradingStateTransition.RESET);
  }

  public forceState(state: TradingState, reason: string): void {
    this.logger.warning(`Force state change to ${state}: ${reason}`);
    const previousState = this.currentState;
    this.currentState = state;
    this.recordStateChange(state);
    this.logger.debug(`Forced state change: ${previousState} → ${state}`);
  }

  private resetContext(): void {
    this.context = {};
  }

  private recordStateChange(state: TradingState, trigger?: TradingStateTransition): void {
    this.stateHistory.push({
      state,
      timestamp: Date.now(),
      trigger,
    });

    // Keep only last 100 state changes
    if (this.stateHistory.length > 100) {
      this.stateHistory = this.stateHistory.slice(-100);
    }
  }

  public getStateDuration(): number {
    const lastChange = this.stateHistory[this.stateHistory.length - 1];
    return lastChange ? Date.now() - lastChange.timestamp : 0;
  }

  public canTransition(trigger: TradingStateTransition): boolean {
    return this.transitionRules.some(
      r =>
        r.from === this.currentState &&
        r.trigger === trigger &&
        (!r.guard || r.guard(this.context)),
    );
  }
}
