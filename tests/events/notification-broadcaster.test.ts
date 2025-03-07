import { EventManager } from '../../src/events/event-manager';
import { NotificationBroadcaster } from '../../src/events/notification-broadcaster';
import { NotificationEvent } from '../../src/events/types';

describe('NotificationBroadcaster', () => {
  let eventManager: EventManager;
  let notificationBroadcaster: NotificationBroadcaster;

  beforeEach(() => {
    // Spy on console methods
    jest.spyOn(console, 'info').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
    
    // Create event manager
    eventManager = new EventManager({
      logToConsole: false,
      storeEvents: false,
    });
    
    // Spy on event manager methods
    jest.spyOn(eventManager, 'on');
    jest.spyOn(eventManager, 'emit');
    
    // Create notification broadcaster with minimal config
    notificationBroadcaster = new NotificationBroadcaster(eventManager, {
      telegram: { enabled: false },
      discord: { enabled: false },
      email: { enabled: false },
    });
  });

  afterEach(() => {
    eventManager.removeAllListeners();
    jest.restoreAllMocks();
  });

  describe('Console Notifications', () => {
    it('should output console notifications with correct formatting', () => {
      // Create notification events for each level
      const infoNotification: NotificationEvent = {
        level: 'info',
        title: 'Info Title',
        message: 'This is an info message',
        timestamp: Date.now(),
      };
      
      const warningNotification: NotificationEvent = {
        level: 'warning',
        title: 'Warning Title',
        message: 'This is a warning message',
        timestamp: Date.now(),
      };
      
      const errorNotification: NotificationEvent = {
        level: 'error',
        title: 'Error Title',
        message: 'This is an error message',
        timestamp: Date.now(),
      };
      
      const successNotification: NotificationEvent = {
        level: 'success',
        title: 'Success Title',
        message: 'This is a success message',
        timestamp: Date.now(),
      };
      
      // Emit events
      eventManager.emit('notification', infoNotification);
      eventManager.emit('notification', warningNotification);
      eventManager.emit('notification', errorNotification);
      eventManager.emit('notification', successNotification);
      
      // Check console outputs
      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining('Info Title: This is an info message')
      );
      
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Warning Title: This is a warning message')
      );
      
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error Title: This is an error message')
      );
      
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Success Title: This is a success message')
      );
    });
  });

  describe('Direct Notification Method', () => {
    it('should emit notification events when using the notify method', () => {
      // Spy on event manager emit method
      jest.spyOn(eventManager, 'emit');
      
      // Send a notification
      notificationBroadcaster.notify(
        'info',
        'Test Direct Notification',
        'This is a direct notification',
        { some: 'data' },
        ['console', 'telegram']
      );
      
      // Check that the event was emitted
      expect(eventManager.emit).toHaveBeenCalledWith(
        'notification',
        expect.objectContaining({
          level: 'info',
          title: 'Test Direct Notification',
          message: 'This is a direct notification',
          data: { some: 'data' },
          channels: ['console', 'telegram'],
        })
      );
    });
  });

  describe('Channel Selection', () => {
    it('should honor channel selection in notification events', () => {
      // Create a notification with specific channels
      const notification: NotificationEvent = {
        level: 'info',
        title: 'Channel Test',
        message: 'This should only go to console',
        timestamp: Date.now(),
        channels: ['console'],
      };
      
      // Emit the event
      eventManager.emit('notification', notification);
      
      // Console should be called
      expect(console.info).toHaveBeenCalled();
    });

    it('should default to all channels if none specified', () => {
      // Create a notification with no channels specified
      const notification: NotificationEvent = {
        level: 'info',
        title: 'Default Channels',
        message: 'This should go to all enabled channels',
        timestamp: Date.now(),
      };
      
      // Emit the event
      eventManager.emit('notification', notification);
      
      // Console should be called (it's the only enabled channel)
      expect(console.info).toHaveBeenCalled();
    });
  });

  describe('Multiple Channel Configuration', () => {
    it('should initialize handlers for all configured channels', () => {
      // Create a broadcaster with multiple channels
      const multiChannelBroadcaster = new NotificationBroadcaster(eventManager, {
        telegram: {
          enabled: true,
          botToken: 'test-token',
          chatId: 'test-chat-id',
        },
        discord: {
          enabled: true,
          webhookUrl: 'https://discord.com/api/webhooks/test',
        },
        email: {
          enabled: false,
        },
      });
      
      // Spy on eventManager.on to see if handlers are registered
      jest.spyOn(eventManager, 'on');
      
      // Send a notification to all channels
      multiChannelBroadcaster.notify(
        'info',
        'Multi-channel Test',
        'This should attempt to go to multiple channels',
      );
      
      // Should have registered for notification events
      expect(eventManager.on).toHaveBeenCalledWith(
        'notification',
        expect.any(Function)
      );
      
      // Console should be called
      expect(console.info).toHaveBeenCalled();
    });
  });
});