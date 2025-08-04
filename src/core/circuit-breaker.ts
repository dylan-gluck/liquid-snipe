import { Logger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  monitoringPeriod: number;
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  totalFailures: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  nextAttemptTime?: number;
  uptime: number;
  downtimeTotal: number;
}

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, failing fast
  HALF_OPEN = 'HALF_OPEN' // Testing if service has recovered
}

/**
 * Circuit breaker implementation to prevent cascading failures
 */
export class CircuitBreaker extends EventEmitter {
  private logger: Logger;
  private options: Required<CircuitBreakerOptions>;
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private nextAttemptTime?: number;
  private stateChangeTime = Date.now();
  private downtimeTotal = 0;

  constructor(options: CircuitBreakerOptions) {
    super();
    this.options = {
      failureThreshold: options.failureThreshold,
      successThreshold: options.successThreshold,
      timeout: options.timeout,
      monitoringPeriod: options.monitoringPeriod,
      name: options.name || 'CircuitBreaker'
    };
    this.logger = new Logger(`CircuitBreaker:${this.options.name}`);
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    // Check if circuit is open
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() < (this.nextAttemptTime || 0)) {
        // Still in timeout period, fail fast
        const error = new Error(`Circuit breaker ${this.options.name} is OPEN - failing fast`);
        this.emit('requestRejected', error);
        throw error;
      } else {
        // Timeout period expired, move to half-open
        this.setState(CircuitBreakerState.HALF_OPEN);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.successCount++;
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.successCount >= this.options.successThreshold) {
        this.setState(CircuitBreakerState.CLOSED);
        this.reset();
      }
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }

    this.emit('success', { state: this.state, successCount: this.successCount });
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: Error): void {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    this.logger.warning(`Circuit breaker failure ${this.failureCount}/${this.options.failureThreshold}: ${error.message}`);

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Any failure in half-open state opens the circuit
      this.setState(CircuitBreakerState.OPEN);
      this.scheduleNextAttempt();
    } else if (this.state === CircuitBreakerState.CLOSED) {
      if (this.failureCount >= this.options.failureThreshold) {
        this.setState(CircuitBreakerState.OPEN);
        this.scheduleNextAttempt();
      }
    }

    this.emit('failure', { error, state: this.state, failureCount: this.failureCount });
  }

  /**
   * Set circuit breaker state and emit events
   */
  private setState(newState: CircuitBreakerState): void {
    const previousState = this.state;
    const now = Date.now();

    // Track downtime when transitioning from open back to closed/half-open
    if (previousState === CircuitBreakerState.OPEN && newState !== CircuitBreakerState.OPEN) {
      this.downtimeTotal += now - this.stateChangeTime;
    }

    this.state = newState;
    this.stateChangeTime = now;

    this.logger.info(`Circuit breaker state changed: ${previousState} -> ${newState}`);

    this.emit('stateChange', {
      from: previousState,
      to: newState,
      timestamp: now,
      stats: this.getStats()
    });

    // Reset counters when moving to half-open
    if (newState === CircuitBreakerState.HALF_OPEN) {
      this.successCount = 0;
    }
  }

  /**
   * Schedule next attempt after timeout
   */
  private scheduleNextAttempt(): void {
    this.nextAttemptTime = Date.now() + this.options.timeout;
    this.logger.info(`Next attempt scheduled for ${new Date(this.nextAttemptTime).toISOString()}`);
  }

  /**
   * Reset circuit breaker to initial state
   */
  private reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = undefined;
    this.logger.info('Circuit breaker reset to closed state');
  }

  /**
   * Get current circuit breaker statistics
   */
  public getStats(): CircuitBreakerStats {
    const now = Date.now();
    let uptime = now - this.stateChangeTime;
    
    // If currently open, don't count as uptime
    if (this.state === CircuitBreakerState.OPEN) {
      uptime = 0;
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: this.nextAttemptTime,
      uptime,
      downtimeTotal: this.downtimeTotal
    };
  }

  /**
   * Get circuit breaker health metrics
   */
  public getHealth(): {
    isHealthy: boolean;
    availability: number;
    errorRate: number;
    meanTimeBetweenFailures: number;
  } {
    const stats = this.getStats();
    const now = Date.now();
    const totalTime = now - (this.lastSuccessTime || now);
    
    return {
      isHealthy: this.state !== CircuitBreakerState.OPEN,
      availability: totalTime > 0 ? ((totalTime - stats.downtimeTotal) / totalTime) * 100 : 100,
      errorRate: stats.totalRequests > 0 ? (stats.totalFailures / stats.totalRequests) * 100 : 0,
      meanTimeBetweenFailures: stats.totalFailures > 1 ? 
        totalTime / stats.totalFailures : 0
    };
  }

  /**
   * Force circuit breaker to open state
   */
  public forceOpen(): void {
    this.setState(CircuitBreakerState.OPEN);
    this.scheduleNextAttempt();
    this.logger.warning('Circuit breaker forced to OPEN state');
  }

  /**
   * Force circuit breaker to closed state
   */
  public forceClosed(): void {
    this.setState(CircuitBreakerState.CLOSED);
    this.reset();
    this.logger.info('Circuit breaker forced to CLOSED state');
  }

  /**
   * Check if circuit is currently allowing requests
   */
  public isRequestAllowed(): boolean {
    if (this.state === CircuitBreakerState.CLOSED || this.state === CircuitBreakerState.HALF_OPEN) {
      return true;
    }

    // In open state, only allow if timeout has expired
    return this.state === CircuitBreakerState.OPEN && Date.now() >= (this.nextAttemptTime || 0);
  }

  /**
   * Get current state
   */
  public getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get circuit breaker name
   */
  public getName(): string {
    return this.options.name;
  }
}

/**
 * Circuit breaker registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private logger: Logger;
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    this.logger = new Logger('CircuitBreakerRegistry');
  }

  /**
   * Create or get a circuit breaker
   */
  public getOrCreate(name: string, options: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    
    if (!breaker) {
      breaker = new CircuitBreaker({ ...options, name });
      this.breakers.set(name, breaker);
      
      // Log state changes
      breaker.on('stateChange', (event) => {
        this.logger.info(`Circuit breaker ${name} changed state: ${event.from} -> ${event.to}`);
      });

      this.logger.info(`Created circuit breaker: ${name}`);
    }

    return breaker;
  }

  /**
   * Get existing circuit breaker
   */
  public get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Remove circuit breaker
   */
  public remove(name: string): boolean {
    const removed = this.breakers.delete(name);
    if (removed) {
      this.logger.info(`Removed circuit breaker: ${name}`);
    }
    return removed;
  }

  /**
   * Get all circuit breaker names
   */
  public getNames(): string[] {
    return Array.from(this.breakers.keys());
  }

  /**
   * Get stats for all circuit breakers
   */
  public getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }

    return stats;
  }

  /**
   * Get health for all circuit breakers
   */
  public getOverallHealth(): {
    totalBreakers: number;
    healthyBreakers: number;
    openBreakers: number;
    overallHealthy: boolean;
  } {
    const breakerStats = Array.from(this.breakers.values()).map(b => ({
      state: b.getState(),
      health: b.getHealth()
    }));

    const totalBreakers = breakerStats.length;
    const healthyBreakers = breakerStats.filter(b => b.health.isHealthy).length;
    const openBreakers = breakerStats.filter(b => b.state === CircuitBreakerState.OPEN).length;

    return {
      totalBreakers,
      healthyBreakers,
      openBreakers,
      overallHealthy: openBreakers === 0
    };
  }

  /**
   * Force all circuit breakers to closed state
   */
  public forceAllClosed(): void {
    for (const breaker of this.breakers.values()) {
      breaker.forceClosed();
    }
    this.logger.info('Forced all circuit breakers to closed state');
  }

  /**
   * Get circuit breakers by state
   */
  public getBreakersByState(state: CircuitBreakerState): CircuitBreaker[] {
    return Array.from(this.breakers.values()).filter(b => b.getState() === state);
  }
}