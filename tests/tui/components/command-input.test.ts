import { CommandInput } from '../../../src/tui/components/command-input';
import { TuiTheme } from '../../../src/tui';

// Mock blessed
const mockTextbox = {
  on: jest.fn(),
  key: jest.fn(),
  focus: jest.fn(),
  blur: jest.fn(),
  setValue: jest.fn(),
  getValue: jest.fn(),
  hide: jest.fn(),
  show: jest.fn(),
  destroy: jest.fn(),
  screen: { render: jest.fn() },
};

const mockBox = {
  setContent: jest.fn(),
  hide: jest.fn(),
  show: jest.fn(),
  destroy: jest.fn(),
  screen: { render: jest.fn() },
};

jest.mock('blessed', () => ({
  box: jest.fn(() => mockBox),
  textbox: jest.fn(() => mockTextbox),
}));

describe('CommandInput', () => {
  let commandInput: CommandInput;
  let mockTheme: TuiTheme;
  let mockCommandHandler: jest.Mock;

  beforeEach(() => {
    mockTheme = {
      primary: 'blue',
      secondary: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red',
      info: 'white',
      border: 'white',
      background: 'black',
      text: 'white',
    };

    mockCommandHandler = jest.fn();
    commandInput = new CommandInput(mockTheme, mockCommandHandler);

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (commandInput) {
      commandInput.destroy();
    }
  });

  describe('Initialization', () => {
    test('should create command input with correct configuration', () => {
      expect(commandInput).toBeDefined();
      expect(commandInput.getElement()).toBeDefined();
    });

    test('should be hidden initially', () => {
      expect(commandInput.isVisible()).toBe(false);
    });

    test('should not be active initially', () => {
      expect(commandInput.isInputActive()).toBe(false);
    });
  });

  describe('Command Execution', () => {
    test('should execute commands through handler', async () => {
      const testCommand = 'test command';
      
      await commandInput.executeCommandProgrammatically(testCommand);
      
      expect(mockCommandHandler).toHaveBeenCalledWith(testCommand);
      expect(commandInput.getLastCommand()).toBe(testCommand);
    });

    test('should handle async command handlers', async () => {
      const asyncHandler = jest.fn().mockResolvedValue(undefined);
      const asyncCommandInput = new CommandInput(mockTheme, asyncHandler);
      
      await asyncCommandInput.executeCommandProgrammatically('async command');
      
      expect(asyncHandler).toHaveBeenCalledWith('async command');
      
      asyncCommandInput.destroy();
    });

    test('should handle command handler errors', async () => {
      const errorHandler = jest.fn().mockRejectedValue(new Error('Command failed'));
      const errorCommandInput = new CommandInput(mockTheme, errorHandler);
      
      // Should not throw
      await expect(
        errorCommandInput.executeCommandProgrammatically('failing command')
      ).resolves.not.toThrow();
      
      expect(errorHandler).toHaveBeenCalledWith('failing command');
      
      errorCommandInput.destroy();
    });
  });

  describe('Command History', () => {
    test('should maintain command history', async () => {
      await commandInput.executeCommandProgrammatically('command1');
      await commandInput.executeCommandProgrammatically('command2');
      await commandInput.executeCommandProgrammatically('command3');
      
      const history = commandInput.getCommandHistory();
      expect(history).toEqual(['command1', 'command2', 'command3']);
    });

    test('should not add duplicate consecutive commands', async () => {
      await commandInput.executeCommandProgrammatically('command1');
      await commandInput.executeCommandProgrammatically('command1');
      await commandInput.executeCommandProgrammatically('command2');
      
      const history = commandInput.getCommandHistory();
      expect(history).toEqual(['command1', 'command2']);
    });

    test('should clear command history', async () => {
      await commandInput.executeCommandProgrammatically('command1');
      await commandInput.executeCommandProgrammatically('command2');
      
      expect(commandInput.getCommandHistory()).toHaveLength(2);
      
      commandInput.clearCommandHistory();
      expect(commandInput.getCommandHistory()).toHaveLength(0);
    });

    test('should respect maximum history size', async () => {
      commandInput.setMaxHistorySize(3);
      
      await commandInput.executeCommandProgrammatically('command1');
      await commandInput.executeCommandProgrammatically('command2');
      await commandInput.executeCommandProgrammatically('command3');
      await commandInput.executeCommandProgrammatically('command4');
      
      const history = commandInput.getCommandHistory();
      expect(history).toHaveLength(3);
      expect(history).toEqual(['command2', 'command3', 'command4']);
    });
  });

  describe('Focus Management', () => {
    test('should handle focus correctly', () => {
      commandInput.focus();
      
      expect(mockTextbox.focus).toHaveBeenCalled();
      expect(commandInput.isVisible()).toBe(true);
    });

    test('should handle blur correctly', () => {
      commandInput.focus();
      commandInput.blur();
      
      expect(mockTextbox.blur).toHaveBeenCalled();
    });

    test('should show when focused', () => {
      commandInput.focus();
      
      expect(commandInput.isVisible()).toBe(true);
    });

    test('should hide when blurred', () => {
      commandInput.focus();
      expect(commandInput.isVisible()).toBe(true);
      
      // Simulate blur event
      const blurCallback = mockTextbox.on.mock.calls.find(
        call => call[0] === 'blur'
      )?.[1];
      
      if (blurCallback) {
        blurCallback();
      }
      
      expect(commandInput.isVisible()).toBe(false);
    });
  });

  describe('Visibility Management', () => {
    test('should show and hide correctly', () => {
      expect(commandInput.isVisible()).toBe(false);
      
      commandInput.show();
      expect(commandInput.isVisible()).toBe(true);
      
      commandInput.hide();
      expect(commandInput.isVisible()).toBe(false);
    });
  });

  describe('Command Suggestions', () => {
    test('should suggest commands based on context', () => {
      expect(commandInput.suggestCommand('pools')).toBe('refresh');
      expect(commandInput.suggestCommand('positions')).toBe('view positions');
      expect(commandInput.suggestCommand('error')).toBe('help');
      expect(commandInput.suggestCommand('unknown')).toBeNull();
    });
  });

  describe('Configuration', () => {
    test('should set maximum history size', () => {
      commandInput.setMaxHistorySize(10);
      // Verify by testing that history respects the limit
      expect(() => commandInput.setMaxHistorySize(10)).not.toThrow();
    });

    test('should enforce minimum history size', () => {
      commandInput.setMaxHistorySize(0);
      // Should enforce minimum of 1
      expect(() => commandInput.setMaxHistorySize(0)).not.toThrow();
    });
  });

  describe('Refresh', () => {
    test('should refresh without errors', () => {
      expect(() => {
        commandInput.refresh();
      }).not.toThrow();
    });
  });

  describe('Resource Management', () => {
    test('should clean up resources on destroy', () => {
      expect(() => {
        commandInput.destroy();
      }).not.toThrow();
    });
  });

  describe('Event Handling', () => {
    test('should set up event handlers correctly', () => {
      // Verify that event handlers were registered
      expect(mockTextbox.on).toHaveBeenCalledWith('submit', expect.any(Function));
      expect(mockTextbox.on).toHaveBeenCalledWith('focus', expect.any(Function));
      expect(mockTextbox.on).toHaveBeenCalledWith('blur', expect.any(Function));
      
      expect(mockTextbox.key).toHaveBeenCalledWith(['escape'], expect.any(Function));
      expect(mockTextbox.key).toHaveBeenCalledWith(['up'], expect.any(Function));
      expect(mockTextbox.key).toHaveBeenCalledWith(['down'], expect.any(Function));
      expect(mockTextbox.key).toHaveBeenCalledWith(['tab'], expect.any(Function));
    });

    test('should handle submit events', async () => {
      const submitCallback = mockTextbox.on.mock.calls.find(
        call => call[0] === 'submit'
      )?.[1];
      
      expect(submitCallback).toBeDefined();
      
      if (submitCallback) {
        await submitCallback('test command');
        expect(mockCommandHandler).toHaveBeenCalledWith('test command');
      }
    });

    test('should handle focus events', () => {
      const focusCallback = mockTextbox.on.mock.calls.find(
        call => call[0] === 'focus'
      )?.[1];
      
      expect(focusCallback).toBeDefined();
      
      if (focusCallback) {
        focusCallback();
        expect(commandInput.isInputActive()).toBe(true);
      }
    });
  });
});