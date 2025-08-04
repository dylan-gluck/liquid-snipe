import { Logger } from '../utils/logger';
import { EventManager } from '../events/event-manager';
import { NotificationEvent } from '../events/types';

export interface NotificationChannel {
  name: string;
  enabled: boolean;
  send(notification: ProcessedNotification): Promise<boolean>;
  supports(notification: ProcessedNotification): boolean;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: NotificationCondition[];
  channels: string[];
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  cooldownMinutes?: number;
  maxPerHour?: number;
}

export interface NotificationCondition {
  field: string;
  operator: 'equals' | 'contains' | 'regex' | 'gt' | 'lt' | 'gte' | 'lte';
  value: any;
}

export interface ProcessedNotification extends NotificationEvent {
  ruleId?: string;
  channelResults: Record<string, { success: boolean; error?: string }>;
  processedAt: number;
  retryCount: number;
}

export interface NotificationStats {
  totalSent: number;
  totalFailed: number;
  byChannel: Record<string, { sent: number; failed: number }>;
  byLevel: Record<string, number>;
  recentFailures: Array<{ timestamp: number; channel: string; error: string }>;
}

/**
 * Console notification channel for development/debugging
 */
export class ConsoleNotificationChannel implements NotificationChannel {
  name = 'console';
  enabled = true;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('ConsoleNotifications');
  }

  async send(notification: ProcessedNotification): Promise<boolean> {
    const logLevel = notification.level === 'error' ? 'error' :
                    notification.level === 'warning' ? 'warning' : 'info';

    this.logger[logLevel](`[${notification.level.toUpperCase()}] ${notification.title}`, {
      message: notification.message,
      urgent: notification.urgent,
      data: notification.data
    });

    return true;
  }

  supports(notification: ProcessedNotification): boolean {
    return true; // Console supports all notifications
  }
}

/**
 * Event-based notification channel that emits to the event system
 */
export class EventNotificationChannel implements NotificationChannel {
  name = 'event';
  enabled = true;

  constructor(private eventManager: EventManager) {}

  async send(notification: ProcessedNotification): Promise<boolean> {
    try {
      // Emit as system status for critical errors
      if (notification.level === 'error' && notification.urgent) {
        this.eventManager.emit('systemStatus', {
          status: 'ERROR',
          timestamp: notification.timestamp,
          reason: notification.title,
          data: notification.data
        });
      }

      // Always emit as log event
      this.eventManager.emit('log', {
        level: notification.level === 'info' ? 'info' : 
               notification.level === 'warning' ? 'warning' : 'error',
        message: `${notification.title}: ${notification.message}`,
        timestamp: notification.timestamp,
        data: notification.data
      });

      return true;
    } catch (error) {
      return false;
    }
  }

  supports(notification: ProcessedNotification): boolean {
    return true;
  }
}

/**
 * File-based notification channel for persistent logging
 */
export class FileNotificationChannel implements NotificationChannel {
  name = 'file';
  enabled = true;
  private logger: Logger;

  constructor(private filePath?: string) {
    this.logger = new Logger('FileNotifications');
  }

  async send(notification: ProcessedNotification): Promise<boolean> {
    try {
      // In a real implementation, this would write to a file
      // For now, just use console output with file prefix
      const logEntry = {
        timestamp: new Date(notification.timestamp).toISOString(),
        level: notification.level,
        title: notification.title,
        message: notification.message,
        urgent: notification.urgent,
        data: notification.data
      };

      this.logger.info(`FILE_LOG: ${JSON.stringify(logEntry)}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to write notification to file: ${error}`);
      return false;
    }
  }

  supports(notification: ProcessedNotification): boolean {
    return true;
  }
}

/**
 * Comprehensive notification system for error alerts and system updates
 */
export class NotificationSystem {
  private logger: Logger;
  private channels = new Map<string, NotificationChannel>();
  private rules: NotificationRule[] = [];
  private stats: NotificationStats = {
    totalSent: 0,
    totalFailed: 0,
    byChannel: {},
    byLevel: {},
    recentFailures: []
  };
  private cooldowns = new Map<string, number>();
  private hourlyCounts = new Map<string, Array<{ timestamp: number; count: number }>>();

  constructor(private eventManager: EventManager) {
    this.logger = new Logger('NotificationSystem');
    this.setupDefaultChannels();
    this.setupDefaultRules();
    this.setupEventHandlers();
  }

  /**
   * Setup default notification channels
   */
  private setupDefaultChannels(): void {
    this.addChannel(new ConsoleNotificationChannel());
    this.addChannel(new EventNotificationChannel(this.eventManager));
    this.addChannel(new FileNotificationChannel());
  }

  /**
   * Setup default notification rules
   */
  private setupDefaultRules(): void {
    // Critical error notifications
    this.addRule({
      id: 'critical-errors',
      name: 'Critical Error Notifications',
      enabled: true,
      conditions: [
        { field: 'level', operator: 'equals', value: 'error' },
        { field: 'urgent', operator: 'equals', value: true }
      ],
      channels: ['console', 'event', 'file'],
      priority: 'CRITICAL'
    });

    // High-volume trading notifications
    this.addRule({
      id: 'trading-alerts',
      name: 'Trading Alert Notifications',
      enabled: true,
      conditions: [
        { field: 'data.component', operator: 'equals', value: 'TradeExecutor' }
      ],
      channels: ['console', 'event'],
      priority: 'HIGH',
      maxPerHour: 10
    });

    // System status notifications
    this.addRule({
      id: 'system-status',
      name: 'System Status Notifications',
      enabled: true,
      conditions: [
        { field: 'title', operator: 'contains', value: 'System' }
      ],
      channels: ['console', 'file'],
      priority: 'MEDIUM',
      cooldownMinutes: 5
    });

    // Connection issue notifications
    this.addRule({
      id: 'connection-issues',
      name: 'Connection Issue Notifications',
      enabled: true,
      conditions: [
        { field: 'data.component', operator: 'regex', value: '.*Connection.*' }
      ],
      channels: ['console', 'event'],
      priority: 'HIGH',
      cooldownMinutes: 2
    });
  }

  /**
   * Setup event handlers for automatic notifications
   */
  private setupEventHandlers(): void {
    // Listen for notification events
    this.eventManager.on('notification', async (notification: NotificationEvent) => {
      await this.sendNotification(notification);
    });
  }

  /**
   * Add a notification channel
   */
  public addChannel(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
    this.stats.byChannel[channel.name] = { sent: 0, failed: 0 };
    this.logger.info(`Added notification channel: ${channel.name}`);
  }

  /**
   * Remove a notification channel
   */
  public removeChannel(channelName: string): boolean {
    const removed = this.channels.delete(channelName);
    if (removed) {
      delete this.stats.byChannel[channelName];
      this.logger.info(`Removed notification channel: ${channelName}`);
    }
    return removed;
  }

  /**
   * Add a notification rule
   */
  public addRule(rule: NotificationRule): void {
    this.rules.push(rule);
    this.logger.info(`Added notification rule: ${rule.name}`);
  }

  /**
   * Remove a notification rule
   */
  public removeRule(ruleId: string): boolean {
    const initialLength = this.rules.length;
    this.rules = this.rules.filter(rule => rule.id !== ruleId);
    const removed = this.rules.length < initialLength;
    
    if (removed) {
      this.logger.info(`Removed notification rule: ${ruleId}`);
    }
    
    return removed;
  }

  /**
   * Send a notification through the system
   */
  public async sendNotification(notification: NotificationEvent): Promise<ProcessedNotification> {
    const processed: ProcessedNotification = {
      ...notification,
      channelResults: {},
      processedAt: Date.now(),
      retryCount: 0
    };

    // Find matching rules
    const matchingRules = this.rules.filter(rule => 
      rule.enabled && this.matchesRule(notification, rule)
    );

    if (matchingRules.length === 0) {
      this.logger.debug(`No matching rules for notification: ${notification.title}`);
      return processed;
    }

    // Process each matching rule
    for (const rule of matchingRules) {
      if (!this.canSendForRule(rule, notification)) {
        this.logger.debug(`Rate limiting/cooldown active for rule: ${rule.name}`);
        continue;
      }

      processed.ruleId = rule.id;

      // Send through specified channels
      for (const channelName of rule.channels) {
        const channel = this.channels.get(channelName);
        
        if (!channel || !channel.enabled) {
          processed.channelResults[channelName] = {
            success: false,
            error: 'Channel not available or disabled'
          };
          continue;
        }

        if (!channel.supports(processed)) {
          processed.channelResults[channelName] = {
            success: false,
            error: 'Channel does not support this notification type'
          };
          continue;
        }

        try {
          const success = await channel.send(processed);
          processed.channelResults[channelName] = { success };

          // Update stats
          if (success) {
            this.stats.totalSent++;
            this.stats.byChannel[channelName].sent++;
          } else {
            this.stats.totalFailed++;
            this.stats.byChannel[channelName].failed++;
            this.recordFailure(channelName, 'Send failed');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          processed.channelResults[channelName] = {
            success: false,
            error: errorMessage
          };
          
          this.stats.totalFailed++;
          this.stats.byChannel[channelName].failed++;
          this.recordFailure(channelName, errorMessage);
        }
      }

      // Update rule cooldowns and rate limits
      this.updateRuleLimits(rule);
    }

    // Update level stats
    this.stats.byLevel[notification.level] = (this.stats.byLevel[notification.level] || 0) + 1;

    return processed;
  }

  /**
   * Check if notification matches rule conditions
   */
  private matchesRule(notification: NotificationEvent, rule: NotificationRule): boolean {
    return rule.conditions.every(condition => {
      const value = this.getNestedValue(notification, condition.field);
      
      switch (condition.operator) {
        case 'equals':
          return value === condition.value;
        case 'contains':
          return String(value).includes(String(condition.value));
        case 'regex':
          return new RegExp(condition.value).test(String(value));
        case 'gt':
          return Number(value) > Number(condition.value);
        case 'lt':
          return Number(value) < Number(condition.value);
        case 'gte':
          return Number(value) >= Number(condition.value);
        case 'lte':
          return Number(value) <= Number(condition.value);
        default:
          return false;
      }
    });
  }

  /**
   * Check if notification can be sent for a rule (rate limiting/cooldown)
   */
  private canSendForRule(rule: NotificationRule, notification: NotificationEvent): boolean {
    const now = Date.now();

    // Check cooldown
    if (rule.cooldownMinutes) {
      const lastSent = this.cooldowns.get(rule.id);
      if (lastSent && (now - lastSent) < (rule.cooldownMinutes * 60 * 1000)) {
        return false;
      }
    }

    // Check hourly rate limit
    if (rule.maxPerHour) {
      const hourlyCounts = this.hourlyCounts.get(rule.id) || [];
      const hourAgo = now - (60 * 60 * 1000);
      const recentCounts = hourlyCounts.filter(entry => entry.timestamp > hourAgo);
      const totalInLastHour = recentCounts.reduce((sum, entry) => sum + entry.count, 0);
      
      if (totalInLastHour >= rule.maxPerHour) {
        return false;
      }
    }

    return true;
  }

  /**
   * Update rule limits after sending
   */
  private updateRuleLimits(rule: NotificationRule): void {
    const now = Date.now();

    // Update cooldown
    if (rule.cooldownMinutes) {
      this.cooldowns.set(rule.id, now);
    }

    // Update hourly count
    if (rule.maxPerHour) {
      const hourlyCounts = this.hourlyCounts.get(rule.id) || [];
      hourlyCounts.push({ timestamp: now, count: 1 });
      
      // Clean old entries
      const hourAgo = now - (60 * 60 * 1000);
      const filteredCounts = hourlyCounts.filter(entry => entry.timestamp > hourAgo);
      
      this.hourlyCounts.set(rule.id, filteredCounts);
    }
  }

  /**
   * Record a failure for statistics
   */
  private recordFailure(channelName: string, error: string): void {
    this.stats.recentFailures.push({
      timestamp: Date.now(),
      channel: channelName,
      error
    });

    // Keep only recent failures (last 24 hours)
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    this.stats.recentFailures = this.stats.recentFailures.filter(
      failure => failure.timestamp > dayAgo
    );
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Get notification statistics
   */
  public getStats(): NotificationStats {
    return {
      ...this.stats,
      byChannel: { ...this.stats.byChannel },
      byLevel: { ...this.stats.byLevel },
      recentFailures: [...this.stats.recentFailures]
    };
  }

  /**
   * Get active rules
   */
  public getRules(): NotificationRule[] {
    return [...this.rules];
  }

  /**
   * Get available channels
   */
  public getChannels(): Array<{ name: string; enabled: boolean }> {
    return Array.from(this.channels.values()).map(channel => ({
      name: channel.name,
      enabled: channel.enabled
    }));
  }

  /**
   * Enable/disable a channel
   */
  public setChannelEnabled(channelName: string, enabled: boolean): boolean {
    const channel = this.channels.get(channelName);
    if (channel) {
      channel.enabled = enabled;
      this.logger.info(`Channel ${channelName} ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    }
    return false;
  }

  /**
   * Enable/disable a rule
   */
  public setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      this.logger.info(`Rule ${rule.name} ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    }
    return false;
  }

  /**
   * Test notification system by sending a test notification
   */
  public async sendTestNotification(): Promise<ProcessedNotification> {
    const testNotification: NotificationEvent = {
      id: `test-${Date.now()}`,
      level: 'info',
      title: 'Notification System Test',
      message: 'This is a test notification to verify the system is working correctly.',
      timestamp: Date.now(),
      urgent: false,
      data: { test: true }
    };

    return await this.sendNotification(testNotification);
  }
}