import { Logger } from '../utils/logger';
import { EventManager } from '../events/event-manager';
import { NotificationEvent } from '../events/types';

export interface ErrorContext {
  component: string;
  operation: string;
  requestId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

export interface ErrorSeverity {
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  requiresImmedateAction: boolean;
  affectsTrading: boolean;
  affectsSystemStability: boolean;
}

export interface EnrichedError {
  id: string;
  originalError: Error;
  context: ErrorContext;
  severity: ErrorSeverity;
  timestamp: number;
  stackTrace: string;
  recoveryAttempts: number;
  isRecoverable: boolean;
  tags: string[];
}

export interface ErrorHandlerOptions {
  maxRetries?: number;
  retryDelay?: number;
  enableNotifications?: boolean;
  enableMetrics?: boolean;
}

/**
 * Comprehensive error handling system that captures, categorizes, and routes errors
 */
export class ErrorHandler {
  private logger: Logger;
  private eventManager: EventManager;
  private options: Required<ErrorHandlerOptions>;
  private errorRegistry = new Map<string, EnrichedError>();
  private errorMetrics = {
    totalErrors: 0,
    errorsByComponent: new Map<string, number>(),
    errorsBySeverity: new Map<string, number>(),
    recoverySuccessRate: 0,
    lastError: null as EnrichedError | null,
  };

  constructor(eventManager: EventManager, options: ErrorHandlerOptions = {}) {
    this.logger = new Logger('ErrorHandler');
    this.eventManager = eventManager;
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      enableNotifications: options.enableNotifications ?? true,
      enableMetrics: options.enableMetrics ?? true,
    };
  }

  /**
   * Capture and enrich an error with context information
   */
  public captureError(
    error: Error,
    context: ErrorContext,
    severity?: Partial<ErrorSeverity>,
  ): EnrichedError {
    const enrichedError: EnrichedError = {
      id: this.generateErrorId(),
      originalError: error,
      context,
      severity: this.determineSeverity(error, context, severity),
      timestamp: Date.now(),
      stackTrace: error.stack || 'No stack trace available',
      recoveryAttempts: 0,
      isRecoverable: this.isRecoverableError(error, context),
      tags: this.generateTags(error, context),
    };

    // Store in registry
    this.errorRegistry.set(enrichedError.id, enrichedError);

    // Update metrics
    this.updateMetrics(enrichedError);

    // Log the error
    this.logEnrichedError(enrichedError);

    // Route to appropriate handlers
    this.routeError(enrichedError);

    return enrichedError;
  }

  /**
   * Handle a specific error based on its characteristics
   */
  public async handleError(enrichedError: EnrichedError): Promise<boolean> {
    this.logger.info(`Handling error ${enrichedError.id} from ${enrichedError.context.component}`);

    try {
      // Emit error event for other systems to react
      this.eventManager.emit('error', {
        error: enrichedError.originalError,
        context: enrichedError.context.component,
        category: {
          category: this.mapComponentToCategory(enrichedError.context.component),
          severity: enrichedError.severity.level,
          recoverable: enrichedError.isRecoverable,
        },
      });

      // Send notification if enabled and severity is high enough
      if (this.options.enableNotifications && enrichedError.severity.level !== 'LOW') {
        await this.sendErrorNotification(enrichedError);
      }

      // If error is recoverable, attempt recovery
      if (enrichedError.isRecoverable && enrichedError.recoveryAttempts < this.options.maxRetries) {
        return await this.attemptRecovery(enrichedError);
      }

      // For critical errors that can't be recovered, trigger emergency procedures
      if (enrichedError.severity.level === 'CRITICAL' && !enrichedError.isRecoverable) {
        await this.handleCriticalError(enrichedError);
      }

      return false;
    } catch (handlingError) {
      this.logger.error(`Error while handling error ${enrichedError.id}: ${handlingError}`);
      return false;
    }
  }

  /**
   * Attempt to recover from an error
   */
  private async attemptRecovery(enrichedError: EnrichedError): Promise<boolean> {
    enrichedError.recoveryAttempts++;

    this.logger.info(
      `Attempting recovery ${enrichedError.recoveryAttempts}/${this.options.maxRetries} for error ${enrichedError.id}`,
    );

    try {
      // Wait before retry
      await new Promise(resolve =>
        setTimeout(resolve, this.options.retryDelay * enrichedError.recoveryAttempts),
      );

      // Attempt component-specific recovery
      const success = await this.performComponentRecovery(enrichedError);

      if (success) {
        this.logger.success(`Recovery successful for error ${enrichedError.id}`);
        this.errorRegistry.delete(enrichedError.id);
        return true;
      }

      // If still have retries left, schedule another attempt
      if (enrichedError.recoveryAttempts < this.options.maxRetries) {
        setTimeout(() => this.attemptRecovery(enrichedError), this.options.retryDelay);
      }

      return false;
    } catch (recoveryError) {
      this.logger.error(`Recovery attempt failed for error ${enrichedError.id}: ${recoveryError}`);
      return false;
    }
  }

  /**
   * Perform component-specific recovery actions
   */
  private async performComponentRecovery(enrichedError: EnrichedError): Promise<boolean> {
    const component = enrichedError.context.component;

    switch (component) {
      case 'ConnectionManager':
      case 'BlockchainWatcher':
        // Connection-related recovery handled by existing error recovery workflow
        return true;

      case 'DatabaseManager':
        // Database recovery - attempt to reconnect
        return await this.recoverDatabase(enrichedError);

      case 'TradeExecutor':
        // Trading recovery - validate state and retry if safe
        return await this.recoverTrading(enrichedError);

      case 'TuiController':
        // UI recovery - refresh components
        return await this.recoverUI(enrichedError);

      default:
        this.logger.warning(`No specific recovery strategy for component: ${component}`);
        return false;
    }
  }

  /**
   * Handle critical errors that require immediate action
   */
  private async handleCriticalError(enrichedError: EnrichedError): Promise<void> {
    this.logger.error(`CRITICAL ERROR detected: ${enrichedError.originalError.message}`);

    // Emit critical error event
    this.eventManager.emit('notification', {
      id: `critical-${enrichedError.id}`,
      level: 'error',
      title: 'Critical System Error',
      message: `Critical error in ${enrichedError.context.component}: ${enrichedError.originalError.message}`,
      timestamp: Date.now(),
      urgent: true,
      data: {
        errorId: enrichedError.id,
        component: enrichedError.context.component,
        operation: enrichedError.context.operation,
      },
    });

    // For system stability issues, may need to trigger shutdown
    if (enrichedError.severity.affectsSystemStability) {
      this.logger.error('System stability compromised - emergency procedures may be needed');

      this.eventManager.emit('systemStatus', {
        status: 'CRITICAL_ERROR',
        timestamp: Date.now(),
        reason: `Critical error in ${enrichedError.context.component}`,
        data: { errorId: enrichedError.id },
      });
    }
  }

  /**
   * Send error notification
   */
  private async sendErrorNotification(enrichedError: EnrichedError): Promise<void> {
    const notification: NotificationEvent = {
      id: `error-${enrichedError.id}`,
      level: enrichedError.severity.level === 'CRITICAL' ? 'error' : 'warning',
      title: `${enrichedError.severity.level} Error in ${enrichedError.context.component}`,
      message: enrichedError.originalError.message,
      timestamp: enrichedError.timestamp,
      urgent: enrichedError.severity.requiresImmedateAction,
      data: {
        errorId: enrichedError.id,
        component: enrichedError.context.component,
        operation: enrichedError.context.operation,
        recoverable: enrichedError.isRecoverable,
        tags: enrichedError.tags,
      },
    };

    this.eventManager.emit('notification', notification);
  }

  /**
   * Route error to appropriate handlers based on severity and component
   */
  private routeError(enrichedError: EnrichedError): void {
    // Route to component-specific handlers
    const handlers = this.getHandlersForError(enrichedError);

    handlers.forEach(handler => {
      try {
        handler(enrichedError);
      } catch (handlerError) {
        this.logger.error(`Error in error handler: ${handlerError}`);
      }
    });
  }

  /**
   * Determine error severity based on error type and context
   */
  private determineSeverity(
    error: Error,
    context: ErrorContext,
    overrides?: Partial<ErrorSeverity>,
  ): ErrorSeverity {
    let severity: ErrorSeverity = {
      level: 'MEDIUM',
      requiresImmedateAction: false,
      affectsTrading: false,
      affectsSystemStability: false,
    };

    // Component-based severity
    if (context.component === 'TradeExecutor') {
      severity.affectsTrading = true;
      severity.level = 'HIGH';
    } else if (context.component === 'ConnectionManager') {
      severity.affectsSystemStability = true;
      severity.level = 'HIGH';
    } else if (context.component === 'DatabaseManager') {
      severity.affectsSystemStability = true;
      severity.level = 'MEDIUM';
    }

    // Error message based severity
    if (error.message.includes('CRITICAL') || error.message.includes('FATAL')) {
      severity.level = 'CRITICAL';
      severity.requiresImmedateAction = true;
    } else if (error.message.includes('timeout') || error.message.includes('connection')) {
      severity.level = 'HIGH';
    }

    // Apply overrides
    if (overrides) {
      severity = { ...severity, ...overrides };
    }

    return severity;
  }

  /**
   * Determine if an error is recoverable
   */
  private isRecoverableError(error: Error, context: ErrorContext): boolean {
    // CRITICAL and FATAL errors are never recoverable
    if (error.message.includes('CRITICAL') || error.message.includes('FATAL')) {
      return false;
    }

    // Programming errors are typically not recoverable
    if (error instanceof TypeError || error instanceof ReferenceError) {
      return false;
    }

    // Network errors are usually recoverable
    if (
      error.message.includes('timeout') ||
      error.message.includes('connection') ||
      error.message.includes('ECONNREFUSED')
    ) {
      return true;
    }

    // Database lock errors are recoverable
    if (error.message.includes('database is locked') || error.message.includes('SQLITE_BUSY')) {
      return true;
    }

    // Component-specific recovery rules
    if (context.component === 'ConnectionManager' || context.component === 'BlockchainWatcher') {
      return true;
    }

    return true; // Default to recoverable
  }

  /**
   * Generate tags for error categorization
   */
  private generateTags(error: Error, context: ErrorContext): string[] {
    const tags: string[] = [context.component];

    // Add operation tag if available
    if (context.operation) {
      tags.push(`operation:${context.operation}`);
    }

    // Add error type tags
    if (error.message.includes('timeout')) {
      tags.push('timeout');
    }
    if (error.message.includes('connection')) {
      tags.push('network');
    }
    if (error.message.includes('database')) {
      tags.push('database');
    }
    if (error.message.includes('trade') || error.message.includes('transaction')) {
      tags.push('trading');
    }

    return tags;
  }

  /**
   * Generate unique error ID
   */
  private generateErrorId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Update error metrics
   */
  private updateMetrics(enrichedError: EnrichedError): void {
    if (!this.options.enableMetrics) return;

    this.errorMetrics.totalErrors++;
    this.errorMetrics.lastError = enrichedError;

    // Update by component
    const componentCount =
      this.errorMetrics.errorsByComponent.get(enrichedError.context.component) || 0;
    this.errorMetrics.errorsByComponent.set(enrichedError.context.component, componentCount + 1);

    // Update by severity
    const severityCount = this.errorMetrics.errorsBySeverity.get(enrichedError.severity.level) || 0;
    this.errorMetrics.errorsBySeverity.set(enrichedError.severity.level, severityCount + 1);
  }

  /**
   * Log enriched error
   */
  private logEnrichedError(enrichedError: EnrichedError): void {
    const logLevel =
      enrichedError.severity.level === 'CRITICAL'
        ? 'error'
        : enrichedError.severity.level === 'HIGH'
          ? 'error'
          : enrichedError.severity.level === 'MEDIUM'
            ? 'warning'
            : 'info';

    this.logger[logLevel as 'info' | 'warning' | 'error'](
      `[${enrichedError.severity.level}] ${enrichedError.context.component}:${enrichedError.context.operation} - ${enrichedError.originalError.message}`,
      {
        errorId: enrichedError.id,
        tags: enrichedError.tags,
        recoverable: enrichedError.isRecoverable,
        metadata: enrichedError.context.metadata,
      },
    );
  }

  // Component-specific recovery methods
  private async recoverDatabase(enrichedError: EnrichedError): Promise<boolean> {
    this.logger.info('Attempting database recovery');
    // Database recovery logic would go here
    return true;
  }

  private async recoverTrading(enrichedError: EnrichedError): Promise<boolean> {
    this.logger.info('Attempting trading component recovery');
    // Trading recovery logic would go here
    return true;
  }

  private async recoverUI(enrichedError: EnrichedError): Promise<boolean> {
    this.logger.info('Attempting UI recovery');
    // UI recovery logic would go here
    return true;
  }

  // Utility methods
  private mapComponentToCategory(
    component: string,
  ): 'CONNECTION' | 'DATABASE' | 'TRADING' | 'SYSTEM' | 'USER_INPUT' {
    switch (component) {
      case 'ConnectionManager':
      case 'BlockchainWatcher':
        return 'CONNECTION';
      case 'DatabaseManager':
        return 'DATABASE';
      case 'TradeExecutor':
      case 'StrategyEngine':
      case 'PositionManager':
        return 'TRADING';
      case 'TuiController':
        return 'USER_INPUT';
      default:
        return 'SYSTEM';
    }
  }

  private getHandlersForError(enrichedError: EnrichedError): Array<(error: EnrichedError) => void> {
    // Return array of handlers based on error characteristics
    const handlers: Array<(error: EnrichedError) => void> = [];

    // Always handle the error through the main handler
    handlers.push(error => this.handleError(error));

    return handlers;
  }

  // Public API methods
  public getErrorMetrics() {
    return {
      ...this.errorMetrics,
      errorsByComponent: Object.fromEntries(this.errorMetrics.errorsByComponent),
      errorsBySeverity: Object.fromEntries(this.errorMetrics.errorsBySeverity),
    };
  }

  public getActiveErrors(): EnrichedError[] {
    return Array.from(this.errorRegistry.values());
  }

  public clearError(errorId: string): boolean {
    return this.errorRegistry.delete(errorId);
  }

  public getError(errorId: string): EnrichedError | undefined {
    return this.errorRegistry.get(errorId);
  }
}
