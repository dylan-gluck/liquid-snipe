import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';
import { DatabaseManager } from '../../db';
import { LogEvent } from '../../types';

interface LogDisplayEntry {
  timestamp: number;
  level: LogEvent['level'];
  message: string;
  formattedTime: string;
  formattedMessage: string;
}

export class LogViewer extends BaseComponent {
  private logElement!: blessed.Widgets.BoxElement;
  private logs: LogDisplayEntry[] = [];
  private maxLogs = 1000;
  private filterLevel: LogEvent['level'] | 'all' = 'all';
  private autoScroll = true;

  constructor(
    private dbManager: DatabaseManager,
    theme: TuiTheme,
    config: ComponentConfig = {},
  ) {
    super(
      theme,
      {
        title: 'System Logs',
        ...config,
      },
      'LogViewer',
    );

    this.createLogElement();
    this.setupLogEventHandlers();
  }

  protected createElement(): void {
    super.createElement();

    this.element.style = {
      ...this.element.style,
      transparent: true,
    };

    // Don't set border on main element since child will have its own
  }

  private createLogElement(): void {
    this.logElement = blessed.box({
      parent: this.element,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: this.theme.border,
        },
        bg: this.theme.background,
        fg: this.theme.text,
      },
      tags: true,
      keys: true,
      mouse: true,
      scrollable: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: this.theme.secondary,
        },
        style: {
          inverse: true,
        },
      },
    });
  }

  private setupLogEventHandlers(): void {
    // Keyboard shortcuts for log viewer
    this.logElement.key(['f'], () => {
      this.showFilterDialog();
    });

    this.logElement.key(['c'], () => {
      this.clear();
    });

    this.logElement.key(['s'], () => {
      this.toggleAutoScroll();
    });

    this.logElement.key(['r'], () => {
      this.refresh();
    });

    this.logElement.key(['pageup'], () => {
      this.logElement.scroll(-10);
      this.element.screen?.render();
    });

    this.logElement.key(['pagedown'], () => {
      this.logElement.scroll(10);
      this.element.screen?.render();
    });

    this.logElement.key(['home'], () => {
      this.logElement.setScrollPerc(0);
      this.element.screen?.render();
    });

    this.logElement.key(['end'], () => {
      this.logElement.setScrollPerc(100);
      this.element.screen?.render();
    });
  }

  private showFilterDialog(): void {
    const levels = ['all', 'debug', 'info', 'warning', 'error', 'success'];
    const currentIndex = levels.indexOf(this.filterLevel);

    const filterText = `
{bold}Filter Logs by Level{/bold}

Current filter: {${this.theme.primary}-fg}${this.filterLevel}{/}

Available levels:
${levels
  .map((level, i) => {
    const prefix = i === currentIndex ? '→ ' : '  ';
    const color = i === currentIndex ? this.theme.primary : this.theme.text;
    return `${prefix}{${color}-fg}${level}{/}`;
  })
  .join('\n')}

Use arrow keys to select, Enter to apply, Escape to cancel
    `;

    const filterBox = blessed.message({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '40%',
      height: '60%',
      content: filterText,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: this.theme.primary,
        },
        bg: this.theme.background,
        fg: this.theme.text,
      },
      keys: true,
    });

    let selectedIndex = currentIndex;

    const updateFilterDisplay = () => {
      const updatedText = `
{bold}Filter Logs by Level{/bold}

Current filter: {${this.theme.primary}-fg}${this.filterLevel}{/}

Available levels:
${levels
  .map((level, i) => {
    const prefix = i === selectedIndex ? '→ ' : '  ';
    const color = i === selectedIndex ? this.theme.primary : this.theme.text;
    return `${prefix}{${color}-fg}${level}{/}`;
  })
  .join('\n')}

Use arrow keys to select, Enter to apply, Escape to cancel
      `;
      filterBox.setContent(updatedText);
      this.element.screen?.render();
    };

    filterBox.key(['up'], () => {
      selectedIndex = Math.max(0, selectedIndex - 1);
      updateFilterDisplay();
    });

    filterBox.key(['down'], () => {
      selectedIndex = Math.min(levels.length - 1, selectedIndex + 1);
      updateFilterDisplay();
    });

    filterBox.key(['enter'], () => {
      this.filterLevel = levels[selectedIndex] as LogEvent['level'] | 'all';
      this.updateTitle();
      this.refreshLogDisplay();
      filterBox.destroy();
      this.logElement.focus();
      this.element.screen?.render();
    });

    filterBox.key(['escape'], () => {
      filterBox.destroy();
      this.logElement.focus();
      this.element.screen?.render();
    });

    filterBox.focus();
    this.element.screen?.render();
  }

  private toggleAutoScroll(): void {
    this.autoScroll = !this.autoScroll;

    const status = this.autoScroll ? 'enabled' : 'disabled';
    this.showTemporaryMessage(`Auto-scroll ${status}`, 'info');
  }

  private showTemporaryMessage(message: string, level: LogEvent['level']): void {
    this.addLogEntry({
      timestamp: Date.now(),
      level,
      message,
      formattedTime: this.formatTime(Date.now()),
      formattedMessage: this.formatLogMessage(level, message),
    });
  }

  public async refresh(): Promise<void> {
    try {
      // Load recent logs from database
      const recentLogs = await this.dbManager.getRecentLogEvents(this.maxLogs);

      // Convert to display entries
      this.logs = recentLogs.map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
        formattedTime: this.formatTime(log.timestamp),
        formattedMessage: this.formatLogMessage(log.level, log.message),
      }));

      this.refreshLogDisplay();
      this.updateTitle();
    } catch (error) {
      this.handleError(error, 'Failed to refresh logs');
    }
  }

  private refreshLogDisplay(): void {
    // Clear current log display
    this.logElement.setContent('');

    // Filter logs based on current filter
    const filteredLogs = this.getFilteredLogs();

    // Add logs to display
    const logContent = filteredLogs.map(log => log.formattedMessage).join('\n');
    this.logElement.setContent(logContent);

    if (this.autoScroll) {
      this.logElement.setScrollPerc(100);
    }

    this.element.screen?.render();
  }

  private getFilteredLogs(): LogDisplayEntry[] {
    if (this.filterLevel === 'all') {
      return this.logs;
    }

    return this.logs.filter(log => log.level === this.filterLevel);
  }

  private formatLogMessage(level: LogEvent['level'], message: string): string {
    const timestamp = this.formatTime(Date.now());
    const levelColor = this.getLevelColor(level);
    const levelText = level.toUpperCase().padEnd(7);

    return `{${this.theme.secondary}-fg}${timestamp}{/} {${levelColor}-fg}${levelText}{/} ${message}`;
  }

  private getLevelColor(level: LogEvent['level']): string {
    switch (level) {
      case 'error':
        return this.theme.error;
      case 'warning':
        return this.theme.warning;
      case 'success':
        return this.theme.success;
      case 'debug':
        return this.theme.secondary;
      case 'info':
      default:
        return this.theme.info;
    }
  }

  private updateTitle(): void {
    const filteredCount = this.getFilteredLogs().length;
    const totalCount = this.logs.length;

    let title = `System Logs (${filteredCount}`;
    if (this.filterLevel !== 'all') {
      title += ` of ${totalCount}, filtered: ${this.filterLevel}`;
    }
    title += ')';

    this.setTitle(title);
  }

  public addLogEntry(entry: LogDisplayEntry): void {
    this.logs.push(entry);

    // Trim logs if we exceed maximum
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Refresh display to show new log
    this.refreshLogDisplay();

    this.updateTitle();
    this.element.screen?.render();
  }

  public addLog(level: LogEvent['level'], message: string): void {
    const entry: LogDisplayEntry = {
      timestamp: Date.now(),
      level,
      message,
      formattedTime: this.formatTime(Date.now()),
      formattedMessage: this.formatLogMessage(level, message),
    };

    this.addLogEntry(entry);
  }

  public clear(): void {
    this.logs = [];
    this.logElement.setContent('');
    this.updateTitle();
    this.element.screen?.render();
  }

  public setMaxLogs(maxLogs: number): void {
    this.maxLogs = Math.max(100, maxLogs);

    // Trim current logs if needed
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
      this.refreshLogDisplay();
    }
  }

  public setFilterLevel(level: LogEvent['level'] | 'all'): void {
    this.filterLevel = level;
    this.updateTitle();
    this.refreshLogDisplay();
  }

  public getFilterLevel(): LogEvent['level'] | 'all' {
    return this.filterLevel;
  }

  public isAutoScrollEnabled(): boolean {
    return this.autoScroll;
  }

  public setAutoScroll(enabled: boolean): void {
    this.autoScroll = enabled;
  }

  public getLogs(): LogDisplayEntry[] {
    return [...this.logs];
  }

  public getFilteredLogCount(): number {
    return this.getFilteredLogs().length;
  }

  public exportLogs(): string {
    return this.getFilteredLogs()
      .map(log => `${log.formattedTime} [${log.level.toUpperCase()}] ${log.message}`)
      .join('\n');
  }

  protected onFocus(): void {
    this.logElement.focus();
  }
}

export default LogViewer;
