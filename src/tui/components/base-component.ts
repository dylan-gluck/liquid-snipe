import blessed from 'blessed';
import { TuiTheme } from '../index';
import { Logger } from '../../utils/logger';

export interface ComponentConfig {
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number | string;
  border?: boolean;
  title?: string;
  scrollable?: boolean;
  keys?: boolean;
  mouse?: boolean;
}

export abstract class BaseComponent {
  protected element!: blessed.Widgets.BoxElement;
  protected logger: Logger;
  protected _isVisible = false;
  protected _isActive = false;
  protected lastRefresh = 0;
  protected refreshThrottle = 1000; // Minimum ms between refreshes

  constructor(
    protected theme: TuiTheme,
    protected config: ComponentConfig = {},
    componentName?: string,
  ) {
    this.logger = new Logger(componentName || this.constructor.name);
    this.createElement();
    this.setupEventHandlers();
  }

  protected createElement(): void {
    const defaultConfig: ComponentConfig = {
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: true,
      scrollable: true,
      keys: true,
      mouse: true,
    };

    const mergedConfig = { ...defaultConfig, ...this.config };

    this.element = blessed.box({
      top: mergedConfig.top,
      left: mergedConfig.left,
      width: mergedConfig.width,
      height: mergedConfig.height,
      scrollable: mergedConfig.scrollable,
      keys: mergedConfig.keys,
      mouse: mergedConfig.mouse,
      tags: true,
      border: mergedConfig.border ? {
        type: 'line',
      } : undefined,
      style: {
        border: {
          fg: this.theme.border,
        },
        bg: this.theme.background,
        fg: this.theme.text,
        focus: {
          border: {
            fg: this.theme.primary,
          },
        },
      },
    });

    if (mergedConfig.title) {
      this.element.setLabel(` ${mergedConfig.title} `);
    }

    // Initially hide the component
    this.element.hide();
  }

  protected setupEventHandlers(): void {
    // Base event handling - can be overridden by subclasses
    // Check if element has event methods (for test compatibility)
    if (typeof this.element.on === 'function') {
      this.element.on('focus', () => {
        this._isActive = true;
        this.onFocus();
      });

      this.element.on('blur', () => {
        this._isActive = false;
        this.onBlur();
      });

      this.element.on('resize', () => {
        this.onResize();
      });
    }
  }

  // Abstract methods that must be implemented by subclasses
  public abstract refresh(): Promise<void> | void;

  // Virtual methods that can be overridden
  protected onFocus(): void {
    // Override in subclasses if needed
  }

  protected onBlur(): void {
    // Override in subclasses if needed
  }

  protected onResize(): void {
    // Override in subclasses if needed
  }

  // Common utility methods
  public getElement(): blessed.Widgets.BoxElement {
    return this.element;
  }

  public show(): void {
    this._isVisible = true;
    this.element.show();
    this.element.screen?.render();
  }

  public hide(): void {
    this._isVisible = false;
    this.element.hide();
    this.element.screen?.render();
  }

  public focus(): void {
    this.element.focus();
  }

  public blur(): void {
    // blessed elements don't have a blur method, focus something else
    if (this.element.screen) {
      this.element.screen.focusPop();
    }
  }

  public setTitle(title: string): void {
    this.element.setLabel(` ${title} `);
    this.element.screen?.render();
  }

  public setContent(content: string): void {
    this.element.setContent(content);
    this.element.screen?.render();
  }

  public appendContent(content: string): void {
    const currentContent = this.element.getContent();
    this.element.setContent(currentContent + content);
  }

  public clearContent(): void {
    this.element.setContent('');
    this.element.screen?.render();
  }

  public isVisible(): boolean {
    return this._isVisible;
  }

  public isActive(): boolean {
    return this._isActive;
  }

  public destroy(): void {
    this.element.destroy();
  }

  // Throttled refresh to prevent excessive updates
  public throttledRefresh(): void {
    const now = Date.now();
    if (now - this.lastRefresh >= this.refreshThrottle) {
      this.lastRefresh = now;
      this.refresh();
    }
  }

  // Utility methods for formatting
  protected formatNumber(num: number, decimals = 2): string {
    return num.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  protected formatCurrency(amount: number, currency = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  }

  protected formatPercent(value: number, decimals = 2): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
  }

  protected formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  protected formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
  }

  protected formatDuration(startTime: number, endTime?: number): string {
    const duration = (endTime || Date.now()) - startTime;
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Color formatting helpers
  protected colorizeText(text: string, color: keyof TuiTheme): string {
    return `{${this.theme[color]}-fg}${text}{/}`;
  }

  protected colorizePositive(value: number, text?: string): string {
    const displayText = text || value.toString();
    return value >= 0 
      ? `{${this.theme.success}-fg}${displayText}{/}`
      : `{${this.theme.error}-fg}${displayText}{/}`;
  }

  protected colorizeStatus(status: string): string {
    switch (status.toUpperCase()) {
      case 'OPEN':
      case 'ACTIVE':
      case 'CONNECTED':
      case 'SUCCESS':
        return `{${this.theme.success}-fg}${status}{/}`;
      case 'CLOSED':
      case 'INACTIVE':
      case 'DISCONNECTED':
        return `{${this.theme.secondary}-fg}${status}{/}`;
      case 'ERROR':
      case 'FAILED':
        return `{${this.theme.error}-fg}${status}{/}`;
      case 'WARNING':
      case 'PENDING':
        return `{${this.theme.warning}-fg}${status}{/}`;
      default:
        return `{${this.theme.info}-fg}${status}{/}`;
    }
  }

  // Table formatting helpers
  protected formatTableRow(columns: string[], widths: number[]): string {
    return columns
      .map((col, i) => {
        const width = widths[i] || 10;
        return col.length > width ? col.substring(0, width - 3) + '...' : col.padEnd(width);
      })
      .join(' ');
  }

  protected createTableHeader(headers: string[], widths: number[]): string {
    const headerRow = this.formatTableRow(headers, widths);
    const separator = widths.map(w => '-'.repeat(w)).join(' ');
    return `{bold}${headerRow}{/bold}\n${separator}`;
  }

  // Error handling
  protected handleError(error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`${context}: ${message}`);
    
    // Optionally show error in component
    if (this._isVisible) {
      this.setContent(`{${this.theme.error}-fg}Error: ${message}{/}`);
    }
  }
}

export default BaseComponent;