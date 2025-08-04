import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';

export type CommandHandler = (command: string) => Promise<void> | void;

interface CommandHistory {
  commands: string[];
  currentIndex: number;
  maxHistory: number;
}

export class CommandInput extends BaseComponent {
  private inputElement!: blessed.Widgets.TextboxElement;
  private statusElement!: blessed.Widgets.BoxElement;
  private commandHistory: CommandHistory = {
    commands: [],
    currentIndex: -1,
    maxHistory: 50,
  };
  private lastCommand = '';
  private inputActive = false;

  constructor(
    theme: TuiTheme,
    private commandHandler: CommandHandler,
    config: ComponentConfig = {},
  ) {
    super(
      theme,
      {
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        border: false,
        ...config,
      },
      'CommandInput',
    );

    this.createInputElements();
    this.setupInputHandlers();
  }

  protected createElement(): void {
    super.createElement();

    // Make the main element transparent as we'll handle layout in child elements
    this.element.style = {
      ...this.element.style,
      transparent: true,
    };
  }

  private createInputElements(): void {
    // Status/prompt area
    this.statusElement = blessed.box({
      parent: this.element,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: this.getPrompt(),
      tags: true,
      style: {
        bg: this.theme.background,
        fg: this.theme.text,
      },
    });

    // Command input textbox
    this.inputElement = blessed.textbox({
      parent: this.element,
      top: 1,
      left: 0,
      width: '100%',
      height: 1,
      inputOnFocus: true,
      style: {
        bg: this.theme.background,
        fg: this.theme.text,
        focus: {
          bg: this.theme.primary,
          fg: this.theme.background,
        },
      },
    });

    // Initially hide the input
    this.hide();
  }

  private setupInputHandlers(): void {
    // Handle command submission
    this.inputElement.on('submit', async (value: string) => {
      const command = value.trim();
      if (command) {
        await this.executeCommand(command);
        this.addToHistory(command);
      }
      this.clearInput();
      this.blur();
    });

    // Handle input cancellation
    this.inputElement.key(['escape'], () => {
      this.clearInput();
      this.blur();
    });

    // Handle command history navigation
    this.inputElement.key(['up'], () => {
      this.navigateHistory(-1);
    });

    this.inputElement.key(['down'], () => {
      this.navigateHistory(1);
    });

    // Handle tab completion (basic implementation)
    this.inputElement.key(['tab'], () => {
      this.handleTabCompletion();
    });

    // Handle focus events
    this.inputElement.on('focus', () => {
      this.inputActive = true;
      this.updatePrompt();
    });

    this.inputElement.on('blur', () => {
      this.inputActive = false;
      this.updatePrompt();
      this.hide();
    });
  }

  private getPrompt(): string {
    if (this.inputActive) {
      return `{${this.theme.primary}-fg}Command:{/} `;
    } else {
      return `Press {${this.theme.primary}-fg}/{/} or {${this.theme.primary}-fg}:{/} for commands`;
    }
  }

  private updatePrompt(): void {
    this.statusElement.setContent(this.getPrompt());
    this.element.screen?.render();
  }

  private async executeCommand(command: string): Promise<void> {
    this.lastCommand = command;
    this.showStatus('Executing...', 'info');

    try {
      await this.commandHandler(command);
      this.showStatus(`Executed: ${command}`, 'success', 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showStatus(`Error: ${message}`, 'error', 3000);
    }
  }

  private addToHistory(command: string): void {
    // Don't add duplicate consecutive commands
    if (this.commandHistory.commands[this.commandHistory.commands.length - 1] === command) {
      return;
    }

    this.commandHistory.commands.push(command);

    // Trim history if it gets too long
    if (this.commandHistory.commands.length > this.commandHistory.maxHistory) {
      this.commandHistory.commands.shift();
    }

    // Reset history index
    this.commandHistory.currentIndex = -1;
  }

  private navigateHistory(direction: number): void {
    if (this.commandHistory.commands.length === 0) {
      return;
    }

    const newIndex = this.commandHistory.currentIndex + direction;

    if (newIndex >= 0 && newIndex < this.commandHistory.commands.length) {
      this.commandHistory.currentIndex = newIndex;
      const command =
        this.commandHistory.commands[this.commandHistory.commands.length - 1 - newIndex];
      this.inputElement.setValue(command);
      this.element.screen?.render();
    } else if (newIndex < 0) {
      // Clear input when going beyond history
      this.commandHistory.currentIndex = -1;
      this.inputElement.setValue('');
      this.element.screen?.render();
    }
  }

  private handleTabCompletion(): void {
    const currentValue = this.inputElement.getValue();
    const completions = this.getCompletions(currentValue);

    if (completions.length === 1) {
      // Single completion - apply it
      this.inputElement.setValue(completions[0]);
      this.element.screen?.render();
    } else if (completions.length > 1) {
      // Multiple completions - show them
      this.showCompletions(completions);
    }
  }

  private getCompletions(input: string): string[] {
    const commands = [
      'help',
      'refresh',
      'clear',
      'stats',
      'view pools',
      'view positions',
      'view logs',
      'switch pools',
      'switch positions',
      'switch logs',
      'exit',
      'quit',
    ];

    if (!input.trim()) {
      return commands;
    }

    return commands.filter(cmd => cmd.startsWith(input.toLowerCase()));
  }

  private showCompletions(completions: string[]): void {
    const completionText = completions.join(', ');
    this.showStatus(`Completions: ${completionText}`, 'info', 3000);
  }

  private showStatus(
    message: string,
    type: 'info' | 'success' | 'error' = 'info',
    duration = 1000,
  ): void {
    const color =
      type === 'error'
        ? this.theme.error
        : type === 'success'
          ? this.theme.success
          : this.theme.info;

    this.statusElement.setContent(`{${color}-fg}${message}{/}`);
    this.element.screen?.render();

    // Clear status after duration
    setTimeout(() => {
      this.updatePrompt();
    }, duration);
  }

  private clearInput(): void {
    this.inputElement.setValue('');
    this.commandHistory.currentIndex = -1;
  }

  public focus(): void {
    this.show();
    this.inputElement.focus();
    this.element.screen?.render();
  }

  public blur(): void {
    // Textbox elements don't have a blur method, focus screen instead
    if (this.element.screen) {
      this.element.screen.focusPop();
    }
  }

  public show(): void {
    super.show();
    this.updatePrompt();
  }

  public hide(): void {
    super.hide();
  }

  public refresh(): void {
    // CommandInput doesn't need to refresh data
    this.updatePrompt();
  }

  // Method to programmatically execute a command
  public async executeCommandProgrammatically(command: string): Promise<void> {
    await this.executeCommand(command);
    this.addToHistory(command);
  }

  // Get command history for debugging or other uses
  public getCommandHistory(): string[] {
    return [...this.commandHistory.commands];
  }

  // Clear command history
  public clearCommandHistory(): void {
    this.commandHistory.commands = [];
    this.commandHistory.currentIndex = -1;
  }

  // Set maximum history size
  public setMaxHistorySize(size: number): void {
    this.commandHistory.maxHistory = Math.max(1, size);

    // Trim current history if needed
    while (this.commandHistory.commands.length > this.commandHistory.maxHistory) {
      this.commandHistory.commands.shift();
    }
  }

  // Get the last executed command
  public getLastCommand(): string {
    return this.lastCommand;
  }

  // Check if the input is currently active
  public isInputActive(): boolean {
    return this.inputActive;
  }

  // Method to suggest command based on current context
  public suggestCommand(context: string): string | null {
    switch (context) {
      case 'pools':
        return 'refresh';
      case 'positions':
        return 'view positions';
      case 'error':
        return 'help';
      default:
        return null;
    }
  }

  protected onFocus(): void {
    this.focus();
  }

  protected onBlur(): void {
    this.blur();
  }
}

export default CommandInput;
