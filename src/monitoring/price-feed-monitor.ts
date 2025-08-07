import { EventEmitter } from 'events';
import { Logger } from '../utils/logger';
import { PriceFeedService } from '../data/price-feed-service';

/**
 * Health status for price feed service
 */
export interface PriceFeedHealthStatus {
  timestamp: number;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    coingecko: ServiceStatus;
    birdeye: ServiceStatus;
  };
  performance: {
    avgResponseTime: number;
    successRate: number;
    cacheHitRate: number;
  };
  alerts: Alert[];
}

/**
 * Individual service status
 */
export interface ServiceStatus {
  available: boolean;
  responseTime?: number;
  lastSuccessfulCall?: number;
  errorCount: number;
  rateLimitRemaining: number;
}

/**
 * Alert information
 */
export interface Alert {
  level: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
  service?: string;
}

/**
 * Performance metrics tracking
 */
interface PerformanceMetrics {
  totalRequests: number;
  successfulRequests: number;
  totalResponseTime: number;
  cacheHits: number;
  cacheMisses: number;
  serviceErrors: Map<string, number>;
  lastReset: number;
}

/**
 * Circuit breaker state for API resilience
 */
interface CircuitBreaker {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureTime: number;
  nextAttemptTime: number;
  threshold: number;
  timeout: number;
}

/**
 * Comprehensive monitoring and health checking for price feed services
 */
export class PriceFeedMonitor extends EventEmitter {
  private logger: Logger;
  private priceFeedService: PriceFeedService;
  private metrics: PerformanceMetrics;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private monitoringInterval?: NodeJS.Timeout;
  private alerts: Alert[] = [];
  private healthCheckInterval = 30000; // 30 seconds
  private performanceWindow = 300000; // 5 minutes

  // Circuit breaker configuration
  private readonly circuitBreakerConfig = {
    failureThreshold: 5,
    timeoutMs: 300000, // 5 minutes
  };

  constructor(priceFeedService: PriceFeedService) {
    super();
    this.logger = new Logger('PriceFeedMonitor');
    this.priceFeedService = priceFeedService;

    // Initialize metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      totalResponseTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      serviceErrors: new Map(),
      lastReset: Date.now(),
    };

    // Initialize circuit breakers for each service
    this.initializeCircuitBreakers();

    // Start monitoring
    this.startMonitoring();

    this.logger.info('Price feed monitoring initialized');
  }

  /**
   * Start monitoring services
   */
  public startMonitoring(): void {
    if (this.monitoringInterval) {
      return; // Already monitoring
    }

    this.monitoringInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);

    this.logger.info('Price feed monitoring started');
  }

  /**
   * Stop monitoring
   */
  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.logger.info('Price feed monitoring stopped');
  }

  /**
   * Get current health status
   */
  public getHealthStatus(): PriceFeedHealthStatus {
    const serviceHealth = this.priceFeedService.getHealthStatus();
    
    // Assess overall health
    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    const coingeckoBreaker = this.circuitBreakers.get('coingecko');
    const birdeyeBreaker = this.circuitBreakers.get('birdeye');
    
    if (coingeckoBreaker?.state === 'open' && birdeyeBreaker?.state === 'open') {
      overall = 'unhealthy';
    } else if (coingeckoBreaker?.state === 'open' || birdeyeBreaker?.state === 'open') {
      overall = 'degraded';
    }

    // Calculate performance metrics
    const successRate = this.metrics.totalRequests > 0 
      ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100 
      : 100;

    const avgResponseTime = this.metrics.successfulRequests > 0
      ? this.metrics.totalResponseTime / this.metrics.successfulRequests
      : 0;

    const cacheHitRate = (this.metrics.cacheHits + this.metrics.cacheMisses) > 0
      ? (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100
      : 0;

    return {
      timestamp: Date.now(),
      overall,
      services: {
        coingecko: this.getServiceStatus('coingecko', serviceHealth.coingecko),
        birdeye: this.getServiceStatus('birdeye', serviceHealth.birdeye),
      },
      performance: {
        avgResponseTime,
        successRate,
        cacheHitRate,
      },
      alerts: [...this.alerts],
    };
  }

  /**
   * Record API request metrics
   */
  public recordRequest(service: string, success: boolean, responseTime: number, fromCache: boolean): void {
    this.metrics.totalRequests++;
    
    if (success) {
      this.metrics.successfulRequests++;
      this.metrics.totalResponseTime += responseTime;
      
      // Reset circuit breaker on success
      this.resetCircuitBreaker(service);
    } else {
      // Record failure
      const currentErrors = this.metrics.serviceErrors.get(service) || 0;
      this.metrics.serviceErrors.set(service, currentErrors + 1);
      
      // Update circuit breaker
      this.recordFailure(service);
    }

    if (fromCache) {
      this.metrics.cacheHits++;
    } else {
      this.metrics.cacheMisses++;
    }

    // Reset metrics if window has passed
    if (Date.now() - this.metrics.lastReset > this.performanceWindow) {
      this.resetMetrics();
    }
  }

  /**
   * Check if service is available (not in open circuit breaker state)
   */
  public isServiceAvailable(service: string): boolean {
    const breaker = this.circuitBreakers.get(service);
    if (!breaker) return true;

    if (breaker.state === 'open') {
      if (Date.now() >= breaker.nextAttemptTime) {
        // Move to half-open state
        breaker.state = 'half-open';
        this.logger.info(`Circuit breaker for ${service} moved to half-open state`);
      } else {
        return false;
      }
    }

    return true;
  }

  /**
   * Get recommendations based on current status
   */
  public getRecommendations(): string[] {
    const recommendations: string[] = [];
    const status = this.getHealthStatus();

    // Check overall health
    if (status.overall === 'unhealthy') {
      recommendations.push('All price feed services are unavailable. Consider using fallback pricing or pausing trading.');
    } else if (status.overall === 'degraded') {
      recommendations.push('One or more price feed services are degraded. Monitor closely and consider reducing trade frequency.');
    }

    // Check performance metrics
    if (status.performance.successRate < 80) {
      recommendations.push('Low success rate detected. Check API keys and network connectivity.');
    }

    if (status.performance.avgResponseTime > 5000) {
      recommendations.push('High response times detected. Consider switching to faster RPC endpoints.');
    }

    if (status.performance.cacheHitRate < 30) {
      recommendations.push('Low cache hit rate. Consider increasing cache expiry times.');
    }

    // Check service-specific issues
    if (!status.services.coingecko.available) {
      recommendations.push('Coingecko API is unavailable. Check API key and rate limits.');
    }

    if (!status.services.birdeye.available) {
      recommendations.push('Birdeye API is unavailable. Check API key and rate limits.');
    }

    // Check rate limits
    if (status.services.coingecko.rateLimitRemaining < 5) {
      recommendations.push('Coingecko rate limit is nearly exhausted. Consider reducing request frequency.');
    }

    if (status.services.birdeye.rateLimitRemaining < 10) {
      recommendations.push('Birdeye rate limit is nearly exhausted. Consider reducing request frequency.');
    }

    return recommendations;
  }

  /**
   * Export monitoring data for analysis
   */
  public exportMonitoringData(): {
    metrics: PerformanceMetrics;
    circuitBreakers: Array<{ service: string; state: string; failureCount: number }>;
    alerts: Alert[];
    healthStatus: PriceFeedHealthStatus;
  } {
    return {
      metrics: { ...this.metrics },
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([service, breaker]) => ({
        service,
        state: breaker.state,
        failureCount: breaker.failureCount,
      })),
      alerts: [...this.alerts],
      healthStatus: this.getHealthStatus(),
    };
  }

  /**
   * Initialize circuit breakers for all services
   */
  private initializeCircuitBreakers(): void {
    const services = ['coingecko', 'birdeye'];
    
    services.forEach(service => {
      this.circuitBreakers.set(service, {
        state: 'closed',
        failureCount: 0,
        lastFailureTime: 0,
        nextAttemptTime: 0,
        threshold: this.circuitBreakerConfig.failureThreshold,
        timeout: this.circuitBreakerConfig.timeoutMs,
      });
    });
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(service: string): void {
    const breaker = this.circuitBreakers.get(service);
    if (!breaker) return;

    breaker.failureCount++;
    breaker.lastFailureTime = Date.now();

    if (breaker.state === 'closed' && breaker.failureCount >= breaker.threshold) {
      // Trip the circuit breaker
      breaker.state = 'open';
      breaker.nextAttemptTime = Date.now() + breaker.timeout;
      
      this.addAlert({
        level: 'error',
        message: `Circuit breaker opened for ${service} due to repeated failures`,
        timestamp: Date.now(),
        service,
      });

      this.logger.error(`Circuit breaker opened for ${service}`);
      this.emit('circuitBreakerOpened', { service });
    }
  }

  /**
   * Reset circuit breaker on successful request
   */
  private resetCircuitBreaker(service: string): void {
    const breaker = this.circuitBreakers.get(service);
    if (!breaker) return;

    if (breaker.state === 'half-open') {
      // Reset to closed state
      breaker.state = 'closed';
      breaker.failureCount = 0;
      
      this.addAlert({
        level: 'info',
        message: `Circuit breaker closed for ${service} - service recovered`,
        timestamp: Date.now(),
        service,
      });

      this.logger.info(`Circuit breaker closed for ${service} - service recovered`);
      this.emit('circuitBreakerClosed', { service });
    } else if (breaker.state === 'closed') {
      // Reset failure count on successful request
      breaker.failureCount = Math.max(0, breaker.failureCount - 1);
    }
  }

  /**
   * Perform health check on all services
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const healthStatus = this.getHealthStatus();
      
      // Check for new issues
      this.checkForAlerts(healthStatus);
      
      // Emit health status update
      this.emit('healthStatusUpdate', healthStatus);
      
      // Clean up old alerts (keep last 100)
      if (this.alerts.length > 100) {
        this.alerts = this.alerts.slice(-100);
      }

    } catch (error) {
      this.logger.error('Failed to perform health check', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for alert conditions
   */
  private checkForAlerts(status: PriceFeedHealthStatus): void {
    // Check success rate
    if (status.performance.successRate < 50) {
      this.addAlert({
        level: 'critical',
        message: `Very low success rate: ${status.performance.successRate.toFixed(1)}%`,
        timestamp: Date.now(),
      });
    } else if (status.performance.successRate < 80) {
      this.addAlert({
        level: 'warning',
        message: `Low success rate: ${status.performance.successRate.toFixed(1)}%`,
        timestamp: Date.now(),
      });
    }

    // Check response time
    if (status.performance.avgResponseTime > 10000) {
      this.addAlert({
        level: 'error',
        message: `Very high response time: ${status.performance.avgResponseTime.toFixed(0)}ms`,
        timestamp: Date.now(),
      });
    } else if (status.performance.avgResponseTime > 5000) {
      this.addAlert({
        level: 'warning',
        message: `High response time: ${status.performance.avgResponseTime.toFixed(0)}ms`,
        timestamp: Date.now(),
      });
    }

    // Check service availability
    Object.entries(status.services).forEach(([serviceName, serviceStatus]) => {
      if (!serviceStatus.available) {
        this.addAlert({
          level: 'error',
          message: `${serviceName} service is unavailable`,
          timestamp: Date.now(),
          service: serviceName,
        });
      }

      if (serviceStatus.rateLimitRemaining < 5) {
        this.addAlert({
          level: 'warning',
          message: `${serviceName} rate limit nearly exhausted: ${serviceStatus.rateLimitRemaining} requests remaining`,
          timestamp: Date.now(),
          service: serviceName,
        });
      }
    });
  }

  /**
   * Add an alert if it's not a duplicate
   */
  private addAlert(alert: Alert): void {
    // Check if similar alert exists in the last 5 minutes
    const fiveMinutesAgo = Date.now() - 300000;
    const recentAlerts = this.alerts.filter(a => 
      a.timestamp > fiveMinutesAgo && 
      a.message === alert.message && 
      a.service === alert.service
    );

    if (recentAlerts.length === 0) {
      this.alerts.push(alert);
      this.emit('alert', alert);
      
      if (alert.level === 'info') {
        this.logger.info(`Price feed alert: ${alert.message}`, { service: alert.service });
      } else if (alert.level === 'warning') {
        this.logger.warning(`Price feed alert: ${alert.message}`, { service: alert.service });
      } else {
        this.logger.error(`Price feed alert: ${alert.message}`, { service: alert.service });
      }
    }
  }

  /**
   * Get service status details
   */
  private getServiceStatus(serviceName: string, healthData: any): ServiceStatus {
    const breaker = this.circuitBreakers.get(serviceName);
    const errorCount = this.metrics.serviceErrors.get(serviceName) || 0;

    return {
      available: healthData.available && breaker?.state !== 'open',
      errorCount,
      rateLimitRemaining: healthData.requestsRemaining || 0,
    };
  }

  /**
   * Reset performance metrics
   */
  private resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      totalResponseTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      serviceErrors: new Map(),
      lastReset: Date.now(),
    };
  }

  /**
   * Shutdown monitor
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down price feed monitor');
    
    this.stopMonitoring();
    this.removeAllListeners();
    this.alerts = [];
  }
}