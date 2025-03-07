import { Logger } from '../../src/utils/logger';
import { eventManager } from '../../src/events/event-manager';

describe('Logger', () => {
  // Spy on event manager
  beforeEach(() => {
    jest.spyOn(eventManager, 'emit').mockReturnValue(true);
    
    // Spy on console methods
    jest.spyOn(console, 'info').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();
  });
  
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Basic Logging', () => {
    it('should log messages with the correct level', () => {
      const logger = new Logger('TestModule');
      
      logger.info('Info message');
      logger.warning('Warning message');
      logger.error('Error message');
      logger.success('Success message');
      logger.debug('Debug message'); // Should not appear in non-verbose mode
      
      // Check console output
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[INFO] [TestModule] Info message'));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WARNING] [TestModule] Warning message'));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [TestModule] Error message'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[SUCCESS] [TestModule] Success message'));
      
      // Debug should not be shown in non-verbose mode
      expect(console.debug).not.toHaveBeenCalled();
      
      // Check event emission
      expect(eventManager.emit).toHaveBeenCalledTimes(4); // 4 events, debug not emitted
      expect(eventManager.emit).toHaveBeenCalledWith('log', expect.objectContaining({
        level: 'info',
        message: '[TestModule] Info message',
      }));
    });

    it('should include debug messages in verbose mode', () => {
      const logger = new Logger('TestModule', { verbose: true });
      
      logger.debug('Debug message');
      
      // Debug should be shown in verbose mode
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] [TestModule] Debug message'));
      
      // Debug event should be emitted
      expect(eventManager.emit).toHaveBeenCalledWith('log', expect.objectContaining({
        level: 'debug',
        message: '[TestModule] Debug message',
      }));
    });
    
    it('should include additional data in logs', () => {
      const logger = new Logger('TestModule');
      const data = { userId: 123, action: 'login' };
      
      logger.info('User action', data);
      
      // Event should include data
      expect(eventManager.emit).toHaveBeenCalledWith('log', expect.objectContaining({
        level: 'info',
        message: '[TestModule] User action',
        data,
      }));
      
      // Console should show data
      expect(console.log).toHaveBeenCalledWith('Data:', data);
    });
  });

  describe('Configuration Options', () => {
    it('should respect minimum log level settings', () => {
      const logger = new Logger('TestModule', {
        minLevel: 'warning',
      });
      
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warning('Warning message');
      logger.error('Error message');
      
      // Only warning and error should be logged
      expect(console.debug).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      
      // Only 2 events should be emitted
      expect(eventManager.emit).toHaveBeenCalledTimes(2);
    });

    it('should allow disabling event emission', () => {
      const logger = new Logger('TestModule', {
        emitEvents: false,
      });
      
      logger.info('Info message');
      
      // Console should be called
      expect(console.info).toHaveBeenCalled();
      
      // No events should be emitted
      expect(eventManager.emit).not.toHaveBeenCalled();
    });

    it('should allow disabling console output', () => {
      const logger = new Logger('TestModule', {
        consoleOutput: false,
      });
      
      logger.info('Info message');
      
      // Console should not be called
      expect(console.info).not.toHaveBeenCalled();
      
      // Event should still be emitted
      expect(eventManager.emit).toHaveBeenCalled();
    });
    
    it('should update options with setOptions', () => {
      const logger = new Logger('TestModule');
      
      // Initially should log to console
      logger.info('First message');
      expect(console.info).toHaveBeenCalled();
      
      // Update options to disable console
      logger.setOptions({ consoleOutput: false });
      
      // Reset mock to check if called again
      (console.info as jest.Mock).mockClear();
      
      // Should not log to console now
      logger.info('Second message');
      expect(console.info).not.toHaveBeenCalled();
    });

    it('should update verbose setting with setVerbose', () => {
      const logger = new Logger('TestModule');
      
      // Initially should not log debug messages
      logger.debug('First debug message');
      expect(console.debug).not.toHaveBeenCalled();
      
      // Enable verbose mode
      logger.setVerbose(true);
      
      // Should now log debug messages
      logger.debug('Second debug message');
      expect(console.debug).toHaveBeenCalled();
    });
  });

  describe('Child Loggers', () => {
    it('should create child loggers with nested context', () => {
      const parentLogger = new Logger('Parent');
      const childLogger = parentLogger.child('Child');
      
      childLogger.info('Child message');
      
      // Console should show the nested context
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[Parent:Child] Child message'));
      
      // Event should include the nested context
      expect(eventManager.emit).toHaveBeenCalledWith('log', expect.objectContaining({
        message: '[Parent:Child] Child message',
      }));
    });

    it('should inherit options from parent logger', () => {
      const parentLogger = new Logger('Parent', {
        verbose: true,
        minLevel: 'warning',
      });
      
      const childLogger = parentLogger.child('Child');
      
      // Child should inherit the min level from parent
      childLogger.info('Info message');
      childLogger.warning('Warning message');
      
      // Only warning should be logged
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
      
      // Debug should be logged because verbose is true
      childLogger.debug('Debug message');
      expect(console.debug).toHaveBeenCalled();
    });
  });
});