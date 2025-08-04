import { Logger } from '../utils/logger';
import { EventManager } from './event-manager';
import { NotificationEvent } from './types';

/**
 * Configuration for a notification channel
 */
export interface NotificationChannelConfig {
  enabled: boolean;
  [key: string]: any;
}

/**
 * Configuration for notification channels
 */
export interface NotificationConfig {
  telegram?: NotificationChannelConfig & {
    botToken?: string;
    chatId?: string;
  };
  discord?: NotificationChannelConfig & {
    webhookUrl?: string;
  };
  email?: NotificationChannelConfig & {
    smtpConfig?: {
      host: string;
      port: number;
      secure: boolean;
      auth: {
        user: string;
        pass: string;
      };
    };
    from?: string;
    to?: string[];
  };
}

/**
 * Interface for notification handlers
 */
export interface NotificationHandler {
  /**
   * Send a notification
   * @returns true if successful, false otherwise
   */
  send(notification: NotificationEvent): Promise<boolean>;
}

/**
 * NotificationBroadcaster listens for notification events
 * and broadcasts them to configured channels.
 */
export class NotificationBroadcaster {
  private logger: Logger;
  private eventManager: EventManager;
  private config: NotificationConfig;
  private handlers: Map<string, NotificationHandler> = new Map();

  /**
   * Create a new NotificationBroadcaster
   */
  constructor(eventManager: EventManager, config: NotificationConfig = {}) {
    this.logger = new Logger('NotificationBroadcaster');
    this.eventManager = eventManager;
    this.config = config;

    // Initialize handlers based on config
    this.initializeHandlers();

    // Subscribe to notification events
    this.eventManager.on('notification', async notification => {
      await this.broadcastNotification(notification);
    });
  }

  /**
   * Initialize notification handlers based on configuration
   */
  private initializeHandlers(): void {
    // Console handler is always available
    this.handlers.set('console', {
      send: async (notification: NotificationEvent) => {
        const { level, title, message } = notification;

        switch (level) {
          case 'info':
            console.info(`📢 ${title}: ${message}`);
            break;
          case 'warning':
            console.warn(`⚠️ ${title}: ${message}`);
            break;
          case 'error':
            console.error(`🚨 ${title}: ${message}`);
            break;
          case 'success':
            console.log(`✅ ${title}: ${message}`);
            break;
        }

        return true;
      },
    });

    // Initialize Telegram handler if configured
    if (
      this.config.telegram?.enabled &&
      this.config.telegram.botToken &&
      this.config.telegram.chatId
    ) {
      this.handlers.set('telegram', {
        send: async (notification: NotificationEvent) => {
          try {
            const { level, title, message } = notification;
            const emoji =
              level === 'info'
                ? 'ℹ️'
                : level === 'warning'
                  ? '⚠️'
                  : level === 'error'
                    ? '🚨'
                    : '✅';

            const text = `${emoji} *${title}*\n${message}`;

            // In a real implementation, this would use the Telegram API
            this.logger.info(`Would send Telegram notification: ${text}`);
            return true;
          } catch (error) {
            this.logger.error(
              `Failed to send Telegram notification: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
          }
        },
      });
    }

    // Initialize Discord handler if configured
    if (this.config.discord?.enabled && this.config.discord.webhookUrl) {
      this.handlers.set('discord', {
        send: async (notification: NotificationEvent) => {
          try {
            const { level, title, message } = notification;

            // In a real implementation, this would use the Discord API
            this.logger.info(`Would send Discord notification: [${level}] ${title}: ${message}`);
            return true;
          } catch (error) {
            this.logger.error(
              `Failed to send Discord notification: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
          }
        },
      });
    }

    // Initialize Email handler if configured
    if (this.config.email?.enabled && this.config.email.smtpConfig && this.config.email.to) {
      this.handlers.set('email', {
        send: async (notification: NotificationEvent) => {
          try {
            const { level, title, message } = notification;

            // In a real implementation, this would use a nodemailer or similar
            this.logger.info(`Would send Email notification: [${level}] ${title}: ${message}`);
            return true;
          } catch (error) {
            this.logger.error(
              `Failed to send Email notification: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
          }
        },
      });
    }
  }

  /**
   * Broadcast a notification to all configured channels
   */
  private async broadcastNotification(notification: NotificationEvent): Promise<void> {
    // Determine which channels to send to
    let channels = notification.channels || ['console'];

    // If no channels specified, use all enabled channels
    if (channels.length === 0) {
      channels = Array.from(this.handlers.keys()) as (
        | 'console'
        | 'telegram'
        | 'discord'
        | 'email'
      )[];
    }

    // Send to each channel
    const results = await Promise.all(
      channels.map(async channel => {
        const handler = this.handlers.get(channel);
        if (!handler) {
          this.logger.warning(`No handler configured for notification channel: ${channel}`);
          return false;
        }

        try {
          return await handler.send(notification);
        } catch (error) {
          this.logger.error(
            `Error sending notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      }),
    );

    // Log results
    const successCount = results.filter(Boolean).length;
    if (successCount === 0 && channels.length > 0) {
      this.logger.warning(`Failed to send notification to any channels: ${notification.title}`);
    } else if (successCount < channels.length) {
      this.logger.warning(
        `Sent notification to ${successCount}/${channels.length} channels: ${notification.title}`,
      );
    }
  }

  /**
   * Send a notification directly
   */
  public async notify(
    level: 'info' | 'warning' | 'error' | 'success',
    title: string,
    message: string,
    data?: Record<string, any>,
    channels?: ('console' | 'telegram' | 'discord' | 'email')[],
  ): Promise<void> {
    const notification: NotificationEvent = {
      id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      level,
      title,
      message,
      timestamp: Date.now(),
      data,
      channels,
    };

    // Emit notification event
    this.eventManager.emit('notification', notification);
  }
}

export default NotificationBroadcaster;
