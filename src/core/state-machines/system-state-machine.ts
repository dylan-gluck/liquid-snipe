import { Logger } from '../../utils/logger';

export enum SystemState {
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  MAINTENANCE = 'MAINTENANCE',
  ERROR = 'ERROR',
  SHUTTING_DOWN = 'SHUTTING_DOWN',
  STOPPED = 'STOPPED',
}

export enum SystemStateTransition {
  INITIALIZATION_COMPLETED = 'INITIALIZATION_COMPLETED',
  START_REQUESTED = 'START_REQUESTED',
  PAUSE_REQUESTED = 'PAUSE_REQUESTED',
  RESUME_REQUESTED = 'RESUME_REQUESTED',
  MAINTENANCE_MODE_REQUESTED = 'MAINTENANCE_MODE_REQUESTED',
  MAINTENANCE_COMPLETED = 'MAINTENANCE_COMPLETED',
  SHUTDOWN_REQUESTED = 'SHUTDOWN_REQUESTED',
  SHUTDOWN_COMPLETED = 'SHUTDOWN_COMPLETED',
  ERROR_OCCURRED = 'ERROR_OCCURRED',
  RECOVERY_COMPLETED = 'RECOVERY_COMPLETED',
  FORCE_STOP = 'FORCE_STOP',
}

export interface SystemStateContext {
  startTime?: number;
  lastError?: Error;
  errorCount: number;
  pauseReason?: string;
  maintenanceReason?: string;
  shutdownReason?: string;
  components: {
    database: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
    rpc: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
    blockchain: 'MONITORING' | 'STOPPED' | 'ERROR';
    trading: 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ERROR';
    tui: 'RUNNING' | 'STOPPED' | 'ERROR';
  };
  metrics: {
    totalTrades: number;
    openPositions: number;
    uptime: number;
    lastHealthCheck?: number;
  };
}

export interface SystemStateTransitionRule {
  from: SystemState;
  to: SystemState;
  trigger: SystemStateTransition;
  guard?: (context: SystemStateContext) => boolean;
  action?: (context: SystemStateContext) => void;
}

export class SystemStateMachine {
  private logger: Logger;
  private currentState: SystemState = SystemState.INITIALIZING;
  private context: SystemStateContext;
  private transitionRules: SystemStateTransitionRule[];
  private stateHistory: Array<{
    state: SystemState;
    timestamp: number;
    trigger?: SystemStateTransition;
  }> = [];

  constructor() {
    this.logger = new Logger('SystemStateMachine');
    this.context = this.initializeContext();
    this.transitionRules = this.initializeTransitionRules();
    this.recordStateChange(SystemState.INITIALIZING);
  }

  private initializeContext(): SystemStateContext {
    return {
      errorCount: 0,
      components: {
        database: 'DISCONNECTED',
        rpc: 'DISCONNECTED',
        blockchain: 'STOPPED',
        trading: 'STOPPED',
        tui: 'STOPPED',
      },
      metrics: {
        totalTrades: 0,
        openPositions: 0,
        uptime: 0,
      },
    };
  }

  private initializeTransitionRules(): SystemStateTransitionRule[] {
    return [
      // From INITIALIZING
      {
        from: SystemState.INITIALIZING,
        to: SystemState.READY,
        trigger: SystemStateTransition.INITIALIZATION_COMPLETED,
        guard: context => {
          return (
            context.components.database === 'CONNECTED' && context.components.rpc === 'CONNECTED'
          );
        },
        action: context => {
          this.logger.info('System initialization completed successfully');
        },
      },
      {
        from: SystemState.INITIALIZING,
        to: SystemState.ERROR,
        trigger: SystemStateTransition.ERROR_OCCURRED,
        action: context => {
          this.logger.error(`System initialization failed: ${context.lastError?.message}`);
        },
      },

      // From READY
      {
        from: SystemState.READY,
        to: SystemState.RUNNING,
        trigger: SystemStateTransition.START_REQUESTED,
        action: context => {
          context.startTime = Date.now();
          this.logger.info('System started');
        },
      },
      {
        from: SystemState.READY,
        to: SystemState.SHUTTING_DOWN,
        trigger: SystemStateTransition.SHUTDOWN_REQUESTED,
        action: context => {
          this.logger.info('System shutdown requested from ready state');
        },
      },

      // From RUNNING
      {
        from: SystemState.RUNNING,
        to: SystemState.PAUSED,
        trigger: SystemStateTransition.PAUSE_REQUESTED,
        action: context => {
          this.logger.info(`System paused: ${context.pauseReason || 'No reason provided'}`);
        },
      },
      {
        from: SystemState.RUNNING,
        to: SystemState.MAINTENANCE,
        trigger: SystemStateTransition.MAINTENANCE_MODE_REQUESTED,
        action: context => {
          this.logger.info(
            `Entering maintenance mode: ${context.maintenanceReason || 'No reason provided'}`,
          );
        },
      },
      {
        from: SystemState.RUNNING,
        to: SystemState.SHUTTING_DOWN,
        trigger: SystemStateTransition.SHUTDOWN_REQUESTED,
        action: context => {
          this.logger.info('System shutdown requested');
        },
      },

      // From PAUSED
      {
        from: SystemState.PAUSED,
        to: SystemState.RUNNING,
        trigger: SystemStateTransition.RESUME_REQUESTED,
        action: context => {
          this.logger.info('System resumed from pause');
        },
      },
      {
        from: SystemState.PAUSED,
        to: SystemState.SHUTTING_DOWN,
        trigger: SystemStateTransition.SHUTDOWN_REQUESTED,
        action: context => {
          this.logger.info('System shutdown requested from paused state');
        },
      },

      // From MAINTENANCE
      {
        from: SystemState.MAINTENANCE,
        to: SystemState.RUNNING,
        trigger: SystemStateTransition.MAINTENANCE_COMPLETED,
        action: context => {
          this.logger.info('Maintenance completed, resuming normal operation');
        },
      },
      {
        from: SystemState.MAINTENANCE,
        to: SystemState.SHUTTING_DOWN,
        trigger: SystemStateTransition.SHUTDOWN_REQUESTED,
        action: context => {
          this.logger.info('System shutdown requested from maintenance mode');
        },
      },

      // From ERROR
      {
        from: SystemState.ERROR,
        to: SystemState.READY,
        trigger: SystemStateTransition.RECOVERY_COMPLETED,
        guard: context => {
          return (
            context.components.database === 'CONNECTED' && context.components.rpc === 'CONNECTED'
          );
        },
        action: context => {
          this.logger.info('System recovery completed, returning to ready state');
          context.errorCount = 0;
        },
      },
      {
        from: SystemState.ERROR,
        to: SystemState.SHUTTING_DOWN,
        trigger: SystemStateTransition.SHUTDOWN_REQUESTED,
        action: context => {
          this.logger.info('System shutdown requested from error state');
        },
      },

      // From SHUTTING_DOWN
      {
        from: SystemState.SHUTTING_DOWN,
        to: SystemState.STOPPED,
        trigger: SystemStateTransition.SHUTDOWN_COMPLETED,
        action: context => {
          const uptime = context.startTime ? Date.now() - context.startTime : 0;
          this.logger.info(`System shutdown completed. Total uptime: ${uptime}ms`);
          context.metrics.uptime = uptime;
        },
      },

      // Error transitions from active states
      ...[SystemState.READY, SystemState.RUNNING, SystemState.PAUSED, SystemState.MAINTENANCE].map(
        state => ({
          from: state,
          to: SystemState.ERROR,
          trigger: SystemStateTransition.ERROR_OCCURRED,
          action: (context: SystemStateContext) => {
            context.errorCount++;
            this.logger.error(
              `System error occurred (count: ${context.errorCount}): ${context.lastError?.message}`,
            );
          },
        }),
      ),

      // Force stop from any state except STOPPED
      ...Object.values(SystemState)
        .filter(state => state !== SystemState.STOPPED)
        .map(state => ({
          from: state,
          to: SystemState.STOPPED,
          trigger: SystemStateTransition.FORCE_STOP,
          action: (context: SystemStateContext) => {
            this.logger.warning('System force stopped');
          },
        })),
    ];
  }

  public transition(
    trigger: SystemStateTransition,
    contextUpdates?: Partial<SystemStateContext>,
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

  public updateComponentStatus(
    component: keyof SystemStateContext['components'],
    status: string,
  ): void {
    (this.context.components as any)[component] = status;
    this.logger.debug(`Component ${component} status updated to: ${status}`);
  }

  public getComponentStatus(component: keyof SystemStateContext['components']): string {
    return (this.context.components as any)[component] || 'UNKNOWN';
  }

  public updateMetrics(metrics: Partial<SystemStateContext['metrics']>): void {
    this.context.metrics = { ...this.context.metrics, ...metrics };
  }

  public performHealthCheck(): boolean {
    this.context.metrics.lastHealthCheck = Date.now();

    const healthStatus = {
      database: this.context.components.database === 'CONNECTED',
      rpc: this.context.components.rpc === 'CONNECTED',
      blockchain: ['MONITORING', 'STOPPED'].includes(this.context.components.blockchain),
      trading: ['ACTIVE', 'PAUSED', 'STOPPED'].includes(this.context.components.trading),
      tui: ['RUNNING', 'STOPPED'].includes(this.context.components.tui),
    };

    const isHealthy = Object.values(healthStatus).every(status => status);

    if (!isHealthy) {
      this.logger.warning('Health check failed:', healthStatus);
    }

    return isHealthy;
  }

  public getCurrentState(): SystemState {
    return this.currentState;
  }

  public getContext(): SystemStateContext {
    return { ...this.context };
  }

  public getStateHistory(): Array<{
    state: SystemState;
    timestamp: number;
    trigger?: SystemStateTransition;
  }> {
    return [...this.stateHistory];
  }

  public isInState(state: SystemState): boolean {
    return this.currentState === state;
  }

  public isOperational(): boolean {
    return [SystemState.READY, SystemState.RUNNING, SystemState.PAUSED].includes(this.currentState);
  }

  public isRunning(): boolean {
    return this.currentState === SystemState.RUNNING;
  }

  public isPaused(): boolean {
    return this.currentState === SystemState.PAUSED;
  }

  public hasError(): boolean {
    return this.currentState === SystemState.ERROR;
  }

  public isStopped(): boolean {
    return this.currentState === SystemState.STOPPED;
  }

  public getUptime(): number {
    if (this.context.startTime) {
      return Date.now() - this.context.startTime;
    }
    return 0;
  }

  public getErrorCount(): number {
    return this.context.errorCount;
  }

  public getLastError(): Error | undefined {
    return this.context.lastError;
  }

  public canPause(): boolean {
    return this.currentState === SystemState.RUNNING;
  }

  public canResume(): boolean {
    return this.currentState === SystemState.PAUSED;
  }

  public canShutdown(): boolean {
    return [
      SystemState.READY,
      SystemState.RUNNING,
      SystemState.PAUSED,
      SystemState.MAINTENANCE,
      SystemState.ERROR,
    ].includes(this.currentState);
  }

  public forceState(state: SystemState, reason: string): void {
    this.logger.warning(`Force state change to ${state}: ${reason}`);
    const previousState = this.currentState;
    this.currentState = state;
    this.recordStateChange(state);
    this.logger.debug(`Forced state change: ${previousState} → ${state}`);
  }

  private recordStateChange(state: SystemState, trigger?: SystemStateTransition): void {
    this.stateHistory.push({
      state,
      timestamp: Date.now(),
      trigger,
    });

    // Keep only last 200 state changes
    if (this.stateHistory.length > 200) {
      this.stateHistory = this.stateHistory.slice(-200);
    }
  }

  public getTimeInCurrentState(): number {
    const lastChange = this.stateHistory[this.stateHistory.length - 1];
    return lastChange ? Date.now() - lastChange.timestamp : 0;
  }

  public canTransition(trigger: SystemStateTransition): boolean {
    return this.transitionRules.some(
      r =>
        r.from === this.currentState &&
        r.trigger === trigger &&
        (!r.guard || r.guard(this.context)),
    );
  }
}
