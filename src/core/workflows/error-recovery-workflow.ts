import { Logger } from '../../utils/logger';
import { EventManager } from '../../events/event-manager';
import { ConnectionManager } from '../../blockchain/connection-manager';
import DatabaseManager from '../../db';

export interface ErrorCategory {
  category: 'CONNECTION' | 'DATABASE' | 'TRADING' | 'SYSTEM' | 'USER_INPUT';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recoverable: boolean;
}

export interface ErrorEvent {
  id: string;
  error: Error;
  context: string;
  timestamp: number;
  category: ErrorCategory;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
}

export interface RecoveryAction {
  type: 'RETRY' | 'RECONNECT' | 'RESTART_COMPONENT' | 'FAILOVER' | 'SHUTDOWN';
  component?: string;
  delay?: number;
  maxAttempts?: number;
}

export interface ErrorRecoveryWorkflowState {
  activeErrors: Map<string, ErrorEvent>;
  recoveryInProgress: boolean;
  lastRecoveryAttempt?: number;
  circuitBreakers: Map<string, boolean>;
}

export class ErrorRecoveryWorkflowCoordinator {
  private logger: Logger;
  private workflowState: ErrorRecoveryWorkflowState = {
    activeErrors: new Map(),
    recoveryInProgress: false,
    circuitBreakers: new Map()
  };
  
  private recoveryStrategies = new Map<string, RecoveryAction[]>();

  constructor(
    private eventManager: EventManager,
    private connectionManager: ConnectionManager,
    private dbManager: DatabaseManager
  ) {
    this.logger = new Logger('ErrorRecoveryWorkflow');
    this.setupRecoveryStrategies();
    this.setupEventHandlers();
  }

  private setupRecoveryStrategies(): void {
    // Connection errors
    this.recoveryStrategies.set('CONNECTION', [
      { type: 'RECONNECT', delay: 1000, maxAttempts: 5 },
      { type: 'FAILOVER', delay: 5000, maxAttempts: 3 },
      { type: 'RESTART_COMPONENT', component: 'connection', delay: 10000, maxAttempts: 2 }
    ]);

    // Database errors
    this.recoveryStrategies.set('DATABASE', [
      { type: 'RETRY', delay: 500, maxAttempts: 3 },
      { type: 'RESTART_COMPONENT', component: 'database', delay: 5000, maxAttempts: 2 }
    ]);

    // Trading errors
    this.recoveryStrategies.set('TRADING', [
      { type: 'RETRY', delay: 2000, maxAttempts: 2 },
      { type: 'FAILOVER', delay: 5000, maxAttempts: 1 }
    ]);

    // System errors
    this.recoveryStrategies.set('SYSTEM', [
      { type: 'RESTART_COMPONENT', delay: 1000, maxAttempts: 3 },
      { type: 'SHUTDOWN', delay: 30000, maxAttempts: 1 }
    ]);
  }

  private setupEventHandlers(): void {
    // Handle error events from all components
    this.eventManager.on('error', async (errorData: any) => {
      await this.handleError(errorData);
    });

    // Handle connection errors specifically
    this.connectionManager.on('error', async (error: Error) => {
      await this.handleError({
        error,
        context: 'Solana RPC Connection',
        category: { category: 'CONNECTION', severity: 'HIGH', recoverable: true }
      });
    });

    // Handle connection failures
    this.connectionManager.on('maxReconnectAttemptsReached', async (status: any) => {
      await this.handleError({
        error: new Error('Maximum reconnection attempts reached'),
        context: 'Solana RPC Connection',
        category: { category: 'CONNECTION', severity: 'CRITICAL', recoverable: false }
      });
    });

    // Handle system status changes
    this.eventManager.on('systemStatus', async (status: any) => {
      if (status.status === 'ERROR') {
        await this.handleError({
          error: new Error(status.reason || 'System error'),
          context: 'System Status Change',
          category: { category: 'SYSTEM', severity: 'HIGH', recoverable: true }
        });
      }
    });
  }

  private async handleError(errorData: any): Promise<void> {
    const errorEvent: ErrorEvent = {
      id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      error: errorData.error,
      context: errorData.context || 'Unknown',
      timestamp: Date.now(),
      category: errorData.category || { category: 'SYSTEM', severity: 'MEDIUM', recoverable: true },
      recoveryAttempts: 0,
      maxRecoveryAttempts: this.getMaxRecoveryAttempts(errorData.category?.category || 'SYSTEM')
    };

    this.logger.error(`Error detected: ${errorEvent.context} - ${errorEvent.error.message}`);
    
    // Add to active errors
    this.workflowState.activeErrors.set(errorEvent.id, errorEvent);

    // Check circuit breakers
    if (this.shouldTriggerCircuitBreaker(errorEvent)) {
      await this.triggerCircuitBreaker(errorEvent.category.category);
      return;
    }

    // Attempt recovery if the error is recoverable
    if (errorEvent.category.recoverable) {
      await this.attemptRecovery(errorEvent);
    } else {
      this.logger.error(`Non-recoverable error detected: ${errorEvent.error.message}`);
      
      if (errorEvent.category.severity === 'CRITICAL') {
        await this.handleCriticalError(errorEvent);
      }
    }
  }

  private async attemptRecovery(errorEvent: ErrorEvent): Promise<void> {
    if (this.workflowState.recoveryInProgress) {
      this.logger.warning('Recovery already in progress, queuing error');
      return;
    }

    this.workflowState.recoveryInProgress = true;
    this.workflowState.lastRecoveryAttempt = Date.now();

    try {
      const strategies = this.recoveryStrategies.get(errorEvent.category.category) || [];
      
      for (const strategy of strategies) {
        if (errorEvent.recoveryAttempts >= (strategy.maxAttempts || 3)) {
          continue;
        }

        this.logger.info(`Attempting recovery: ${strategy.type} for ${errorEvent.context}`);
        
        const success = await this.executeRecoveryAction(strategy, errorEvent);
        
        errorEvent.recoveryAttempts++;
        
        if (success) {
          this.logger.info(`Recovery successful for: ${errorEvent.context}`);
          this.workflowState.activeErrors.delete(errorEvent.id);
          
          // Emit recovery success event
          this.eventManager.emit('recoverySuccess', {
            errorId: errorEvent.id,
            context: errorEvent.context,
            strategy: strategy.type,
            attempts: errorEvent.recoveryAttempts,
            timestamp: Date.now()
          });
          
          break;
        } else {
          this.logger.warning(`Recovery attempt failed: ${strategy.type} for ${errorEvent.context}`);
          
          // Wait before next attempt
          if (strategy.delay) {
            await new Promise(resolve => setTimeout(resolve, strategy.delay));
          }
        }
      }

      // If all recovery attempts failed
      if (errorEvent.recoveryAttempts >= errorEvent.maxRecoveryAttempts) {
        this.logger.error(`All recovery attempts exhausted for: ${errorEvent.context}`);
        
        // Emit recovery failure event
        this.eventManager.emit('recoveryFailed', {
          errorId: errorEvent.id,
          context: errorEvent.context,
          totalAttempts: errorEvent.recoveryAttempts,
          timestamp: Date.now()
        });

        // Handle unrecoverable error
        if (errorEvent.category.severity === 'CRITICAL') {
          await this.handleCriticalError(errorEvent);
        }
      }

    } finally {
      this.workflowState.recoveryInProgress = false;
    }
  }

  private async executeRecoveryAction(action: RecoveryAction, errorEvent: ErrorEvent): Promise<boolean> {
    try {
      switch (action.type) {
        case 'RETRY':
          return await this.retryOperation(errorEvent);
        
        case 'RECONNECT':
          return await this.reconnectComponent(errorEvent);
        
        case 'RESTART_COMPONENT':
          return await this.restartComponent(action.component || 'unknown', errorEvent);
        
        case 'FAILOVER':
          return await this.performFailover(errorEvent);
        
        case 'SHUTDOWN':
          await this.performShutdown(errorEvent);
          return true; // Shutdown is always considered successful
        
        default:
          this.logger.warning(`Unknown recovery action: ${action.type}`);
          return false;
      }
    } catch (recoveryError) {
      this.logger.error(`Recovery action failed: ${(recoveryError as Error).message}`);
      return false;
    }
  }

  private async retryOperation(errorEvent: ErrorEvent): Promise<boolean> {
    this.logger.debug(`Retrying operation for: ${errorEvent.context}`);
    
    // In a real implementation, this would retry the failed operation
    // For now, simulate a retry with random success/failure
    await new Promise(resolve => setTimeout(resolve, 500));
    return Math.random() > 0.3; // 70% success rate for simulation
  }

  private async reconnectComponent(errorEvent: ErrorEvent): Promise<boolean> {
    this.logger.info(`Attempting to reconnect component: ${errorEvent.context}`);
    
    try {
      if (errorEvent.context.includes('Connection') || errorEvent.context.includes('RPC')) {
        // Attempt to reconnect to Solana RPC
        await this.connectionManager.reconnect();
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Reconnection failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async restartComponent(component: string, errorEvent: ErrorEvent): Promise<boolean> {
    this.logger.info(`Restarting component: ${component}`);
    
    try {
      switch (component) {
        case 'connection':
          await this.connectionManager.shutdown();
          await this.connectionManager.initialize();
          return true;
        
        case 'database':
          // In a real implementation, you would restart the database connection
          this.logger.debug('Database restart requested (placeholder)');
          return true;
        
        default:
          this.logger.warning(`Unknown component for restart: ${component}`);
          return false;
      }
    } catch (error) {
      this.logger.error(`Component restart failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async performFailover(errorEvent: ErrorEvent): Promise<boolean> {
    this.logger.info(`Performing failover for: ${errorEvent.context}`);
    
    // In a real implementation, this would switch to backup systems
    // For now, this is a placeholder
    await new Promise(resolve => setTimeout(resolve, 1000));
    return Math.random() > 0.5;
  }

  private async performShutdown(errorEvent: ErrorEvent): Promise<void> {
    this.logger.error(`Performing emergency shutdown due to: ${errorEvent.context}`);
    
    // Emit shutdown event
    this.eventManager.emit('emergencyShutdown', {
      reason: errorEvent.context,
      error: errorEvent.error.message,
      timestamp: Date.now()
    });
    
    // In a real implementation, this would initiate graceful shutdown
  }

  private shouldTriggerCircuitBreaker(errorEvent: ErrorEvent): boolean {
    const category = errorEvent.category.category;
    const recentErrors = Array.from(this.workflowState.activeErrors.values())
      .filter(e => e.category.category === category && 
                   Date.now() - e.timestamp < 300000); // 5 minutes
    
    // Trigger circuit breaker if too many errors of the same category
    return recentErrors.length >= 5;
  }

  private async triggerCircuitBreaker(category: string): Promise<void> {
    this.logger.error(`Circuit breaker triggered for category: ${category}`);
    
    this.workflowState.circuitBreakers.set(category, true);
    
    // Emit circuit breaker event
    this.eventManager.emit('circuitBreakerTriggered', {
      category,
      timestamp: Date.now()
    });
    
    // Auto-reset circuit breaker after 10 minutes
    setTimeout(() => {
      this.workflowState.circuitBreakers.set(category, false);
      this.logger.info(`Circuit breaker reset for category: ${category}`);
      
      this.eventManager.emit('circuitBreakerReset', {
        category,
        timestamp: Date.now()
      });
    }, 600000); // 10 minutes
  }

  private async handleCriticalError(errorEvent: ErrorEvent): Promise<void> {
    this.logger.error(`Critical error detected: ${errorEvent.error.message}`);
    
    // Emit critical error event
    this.eventManager.emit('criticalError', {
      errorId: errorEvent.id,
      context: errorEvent.context,
      error: errorEvent.error.message,
      timestamp: Date.now()
    });
    
    // For critical errors, consider emergency shutdown
    if (errorEvent.category.category === 'SYSTEM' || 
        errorEvent.category.category === 'CONNECTION') {
      await this.performShutdown(errorEvent);
    }
  }

  private getMaxRecoveryAttempts(category: string): number {
    const strategies = this.recoveryStrategies.get(category) || [];
    return strategies.reduce((max, strategy) => 
      Math.max(max, strategy.maxAttempts || 3), 3);
  }

  public getWorkflowState(): ErrorRecoveryWorkflowState {
    return {
      activeErrors: new Map(this.workflowState.activeErrors),
      recoveryInProgress: this.workflowState.recoveryInProgress,
      lastRecoveryAttempt: this.workflowState.lastRecoveryAttempt,
      circuitBreakers: new Map(this.workflowState.circuitBreakers)
    };
  }

  public isCircuitBreakerTriggered(category: string): boolean {
    return this.workflowState.circuitBreakers.get(category) || false;
  }

  public getActiveErrorCount(): number {
    return this.workflowState.activeErrors.size;
  }

  public clearError(errorId: string): void {
    this.workflowState.activeErrors.delete(errorId);
    this.logger.debug(`Cleared error: ${errorId}`);
  }
}