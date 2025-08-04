import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';
import { DatabaseManager } from '../../db';
import { Position, Token, ExitStrategyConfig } from '../../types';

interface PositionDisplayData {
  id: string;
  tokenAddress: string;
  tokenSymbol?: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  valueUsd: number;
  pnlUsd: number;
  pnlPercent: number;
  timeHeld: string;
  status: 'OPEN' | 'CLOSED';
  exitStrategy: string;
  exitTrigger?: string;
}

export class PositionsTable extends BaseComponent {
  private tableElement!: blessed.Widgets.ListTableElement;
  private positions: PositionDisplayData[] = [];
  private showClosedPositions = false;
  private sortColumn = 'timeHeld';
  private sortDirection: 'asc' | 'desc' = 'desc';

  constructor(
    private dbManager: DatabaseManager,
    theme: TuiTheme,
    config: ComponentConfig = {},
  ) {
    super(
      theme,
      {
        title: 'Trading Positions',
        ...config,
      },
      'PositionsTable',
    );

    this.createTableElement();
    this.setupTableEventHandlers();
  }

  protected createElement(): void {
    super.createElement();

    this.element.style = {
      ...this.element.style,
      transparent: true,
    };

    // Don't set border on main element since table will have its own
  }

  private createTableElement(): void {
    this.tableElement = blessed.listtable({
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
        header: {
          fg: this.theme.primary,
          bold: true,
        },
        cell: {
          fg: this.theme.text,
        },
        selected: {
          bg: this.theme.primary,
          fg: this.theme.background,
        },
      },
      align: 'left',
      keys: true,
      mouse: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
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

    this.updateTableHeaders();
  }

  private setupTableEventHandlers(): void {
    this.tableElement.on('select', (item, index) => {
      if (index === 0) {
        this.cycleSortColumn();
      } else {
        this.showPositionDetails(index - 1);
      }
    });

    // Keyboard shortcuts
    this.tableElement.key(['s'], () => {
      this.cycleSortColumn();
    });

    this.tableElement.key(['t'], () => {
      this.toggleShowClosed();
    });

    this.tableElement.key(['e'], () => {
      this.editPosition();
    });

    this.tableElement.key(['x'], () => {
      this.exitPosition();
    });

    this.tableElement.key(['r'], () => {
      this.refresh();
    });
  }

  private updateTableHeaders(): void {
    const headers = this.showClosedPositions
      ? ['Token', 'Entry', 'Exit', 'Amount', 'P&L $', 'P&L %', 'Duration', 'Strategy']
      : ['Token', 'Entry', 'Current', 'Amount', 'Value', 'P&L $', 'P&L %', 'Time', 'Strategy'];

    const sortedHeaders = headers.map(header => {
      const columnKey = this.getColumnKey(header);
      if (columnKey === this.sortColumn) {
        const arrow = this.sortDirection === 'asc' ? '↑' : '↓';
        return `${header} ${arrow}`;
      }
      return header;
    });

    this.tableElement.setData([sortedHeaders]);
  }

  private getColumnKey(header: string): string {
    const columnMap: Record<string, string> = {
      Token: 'tokenSymbol',
      Entry: 'entryPrice',
      Current: 'currentPrice',
      Exit: 'currentPrice',
      Amount: 'amount',
      Value: 'valueUsd',
      'P&L $': 'pnlUsd',
      'P&L %': 'pnlPercent',
      Time: 'timeHeld',
      Duration: 'timeHeld',
      Strategy: 'exitStrategy',
    };
    return columnMap[header] || header.toLowerCase();
  }

  private cycleSortColumn(): void {
    const columns = this.showClosedPositions
      ? ['timeHeld', 'pnlPercent', 'pnlUsd', 'tokenSymbol', 'exitStrategy']
      : ['timeHeld', 'pnlPercent', 'pnlUsd', 'valueUsd', 'tokenSymbol'];

    const currentIndex = columns.indexOf(this.sortColumn);

    if (this.sortDirection === 'desc') {
      this.sortDirection = 'asc';
    } else {
      this.sortDirection = 'desc';
      const nextIndex = (currentIndex + 1) % columns.length;
      this.sortColumn = columns[nextIndex];
    }

    this.sortAndUpdateTable();
  }

  private sortAndUpdateTable(): void {
    this.sortPositions();
    this.updateTableData();
    this.updateTableHeaders();
    this.tableElement.screen?.render();
  }

  private sortPositions(): void {
    this.positions.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (this.sortColumn) {
        case 'tokenSymbol':
          aVal = a.tokenSymbol || a.tokenAddress;
          bVal = b.tokenSymbol || b.tokenAddress;
          break;
        case 'entryPrice':
          aVal = a.entryPrice;
          bVal = b.entryPrice;
          break;
        case 'currentPrice':
          aVal = a.currentPrice;
          bVal = b.currentPrice;
          break;
        case 'amount':
          aVal = a.amount;
          bVal = b.amount;
          break;
        case 'valueUsd':
          aVal = a.valueUsd;
          bVal = b.valueUsd;
          break;
        case 'pnlUsd':
          aVal = a.pnlUsd;
          bVal = b.pnlUsd;
          break;
        case 'pnlPercent':
          aVal = a.pnlPercent;
          bVal = b.pnlPercent;
          break;
        case 'timeHeld':
          aVal = this.parseTimeHeld(a.timeHeld);
          bVal = this.parseTimeHeld(b.timeHeld);
          break;
        default:
          aVal = a.exitStrategy;
          bVal = b.exitStrategy;
      }

      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (this.sortDirection === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });
  }

  private parseTimeHeld(timeStr: string): number {
    // Convert time string to milliseconds for sorting
    const parts = timeStr.split(' ');
    let totalMs = 0;

    for (const part of parts) {
      const value = parseInt(part);
      if (part.includes('d')) {
        totalMs += value * 24 * 60 * 60 * 1000;
      } else if (part.includes('h')) {
        totalMs += value * 60 * 60 * 1000;
      } else if (part.includes('m')) {
        totalMs += value * 60 * 1000;
      } else if (part.includes('s')) {
        totalMs += value * 1000;
      }
    }

    return totalMs;
  }

  private updateTableData(): void {
    const tableData = this.positions.map(position => {
      if (this.showClosedPositions) {
        return [
          position.tokenSymbol || this.formatAddress(position.tokenAddress),
          this.formatPrice(position.entryPrice),
          this.formatPrice(position.currentPrice),
          this.formatNumber(position.amount, 4),
          this.colorizePositive(position.pnlUsd, this.formatCurrency(position.pnlUsd)),
          this.colorizePositive(position.pnlPercent, this.formatPercent(position.pnlPercent)),
          position.timeHeld,
          position.exitStrategy,
        ];
      } else {
        return [
          position.tokenSymbol || this.formatAddress(position.tokenAddress),
          this.formatPrice(position.entryPrice),
          this.formatPrice(position.currentPrice),
          this.formatNumber(position.amount, 4),
          this.formatCurrency(position.valueUsd),
          this.colorizePositive(position.pnlUsd, this.formatCurrency(position.pnlUsd)),
          this.colorizePositive(position.pnlPercent, this.formatPercent(position.pnlPercent)),
          position.timeHeld,
          this.formatExitStrategy(position.exitStrategy, position.exitTrigger),
        ];
      }
    });

    const headers = this.showClosedPositions
      ? ['Token', 'Entry', 'Exit', 'Amount', 'P&L $', 'P&L %', 'Duration', 'Strategy']
      : ['Token', 'Entry', 'Current', 'Amount', 'Value', 'P&L $', 'P&L %', 'Time', 'Strategy'];

    const sortedHeaders = headers.map(header => {
      const columnKey = this.getColumnKey(header);
      if (columnKey === this.sortColumn) {
        const arrow = this.sortDirection === 'asc' ? '↑' : '↓';
        return `${header} ${arrow}`;
      }
      return header;
    });

    this.tableElement.setData([sortedHeaders, ...tableData]);
  }

  private formatAddress(address: string): string {
    return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
  }

  private formatPrice(price: number): string {
    if (price < 0.01) {
      return `$${price.toFixed(6)}`;
    } else if (price < 1) {
      return `$${price.toFixed(4)}`;
    } else {
      return `$${price.toFixed(2)}`;
    }
  }

  private formatExitStrategy(strategy: string, exitTrigger?: string): string {
    let display = strategy;
    if (exitTrigger) {
      display += ` (${exitTrigger})`;
    }
    return display.length > 15 ? display.substring(0, 12) + '...' : display;
  }

  private toggleShowClosed(): void {
    this.showClosedPositions = !this.showClosedPositions;
    this.updateTitle();
    this.refresh();
  }

  private updateTitle(): void {
    const prefix = this.showClosedPositions ? 'Closed' : 'Open';
    const count = this.positions.length;
    this.setTitle(`${prefix} Positions (${count})`);
  }

  private async editPosition(): Promise<void> {
    const selectedIndex = 0; // Mock selected index
    if (selectedIndex < 0 || selectedIndex >= this.positions.length) {
      return;
    }

    const position = this.positions[selectedIndex];
    if (position.status !== 'OPEN') {
      this.showMessage('Can only edit open positions', 'warning');
      return;
    }

    // Show edit dialog
    this.showEditPositionDialog(position);
  }

  private async exitPosition(): Promise<void> {
    const selectedIndex = 0; // Mock selected index
    if (selectedIndex < 0 || selectedIndex >= this.positions.length) {
      return;
    }

    const position = this.positions[selectedIndex];
    if (position.status !== 'OPEN') {
      this.showMessage('Position is already closed', 'warning');
      return;
    }

    this.showExitConfirmationDialog(position);
  }

  private showPositionDetails(index: number): void {
    const position = this.positions[index];
    if (!position) return;

    const detailsText = `
{bold}Position Details{/bold}

Token:           ${position.tokenSymbol || 'Unknown'}
Address:         ${position.tokenAddress}
Status:          ${this.colorizeStatus(position.status)}

Entry Price:     ${this.formatPrice(position.entryPrice)}
Current Price:   ${this.formatPrice(position.currentPrice)}
Amount:          ${this.formatNumber(position.amount, 4)}
Current Value:   ${this.formatCurrency(position.valueUsd)}

P&L (USD):       ${this.colorizePositive(position.pnlUsd, this.formatCurrency(position.pnlUsd))}
P&L (%):         ${this.colorizePositive(position.pnlPercent, this.formatPercent(position.pnlPercent))}

Time Held:       ${position.timeHeld}
Exit Strategy:   ${position.exitStrategy}
${position.exitTrigger ? `Exit Trigger:    ${position.exitTrigger}` : ''}

Position ID:     ${position.id}

Press any key to close...
    `;

    const detailsBox = blessed.message({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '80%',
      content: detailsText,
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
    });

    detailsBox.focus();
    this.element.screen?.render();

    detailsBox.key(['escape', 'enter', 'space'], () => {
      detailsBox.destroy();
      this.tableElement.focus();
      this.element.screen?.render();
    });
  }

  private showEditPositionDialog(position: PositionDisplayData): void {
    // Implementation would show a dialog to edit exit strategy
    this.showMessage('Edit position functionality not yet implemented', 'info');
  }

  private showExitConfirmationDialog(position: PositionDisplayData): void {
    const confirmText = `
{bold}Confirm Position Exit{/bold}

Token: ${position.tokenSymbol || this.formatAddress(position.tokenAddress)}
Current Value: ${this.formatCurrency(position.valueUsd)}
Current P&L: ${this.colorizePositive(position.pnlUsd, this.formatCurrency(position.pnlUsd))}

Are you sure you want to exit this position?

Press 'y' to confirm, any other key to cancel
    `;

    const confirmBox = blessed.message({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: '60%',
      content: confirmText,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: this.theme.warning,
        },
        bg: this.theme.background,
        fg: this.theme.text,
      },
    });

    confirmBox.focus();
    this.element.screen?.render();

    confirmBox.key(['y'], () => {
      confirmBox.destroy();
      this.performPositionExit(position);
      this.tableElement.focus();
      this.element.screen?.render();
    });

    confirmBox.key(['escape', 'n', 'enter', 'space'], () => {
      confirmBox.destroy();
      this.tableElement.focus();
      this.element.screen?.render();
    });
  }

  private performPositionExit(position: PositionDisplayData): void {
    // Implementation would trigger position exit through the trading system
    this.showMessage(`Exit request submitted for ${position.tokenSymbol || 'position'}`, 'info');
  }

  private showMessage(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    const color =
      type === 'error'
        ? this.theme.error
        : type === 'warning'
          ? this.theme.warning
          : this.theme.info;

    const messageBox = blessed.message({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '40%',
      height: 'shrink',
      content: `{${color}-fg}${message}{/}`,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: color,
        },
        bg: this.theme.background,
        fg: this.theme.text,
      },
    });

    messageBox.focus();
    this.element.screen?.render();

    setTimeout(() => {
      messageBox.destroy();
      this.tableElement.focus();
      this.element.screen?.render();
    }, 2000);
  }

  public async refresh(): Promise<void> {
    try {
      const positions = this.showClosedPositions
        ? await this.dbManager.getClosedPositions()
        : await this.dbManager.getOpenPositions();

      const positionsWithDisplayData = await Promise.all(
        positions.map(async position => {
          const token = await this.dbManager.getToken(position.tokenAddress);

          // Calculate current values (mock implementation)
          const currentPrice = position.entryPrice * (1 + (Math.random() - 0.5) * 0.4); // ±20% random for demo
          const valueUsd = position.amount * currentPrice;
          const pnlUsd = valueUsd - position.amount * position.entryPrice;
          const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

          const timeHeld = this.formatDuration(position.openTimestamp, position.closeTimestamp);

          const exitStrategy = this.formatExitStrategyName(position.exitStrategy);
          const exitTrigger = this.getExitTrigger(position.exitStrategy);

          return {
            id: position.id,
            tokenAddress: position.tokenAddress,
            tokenSymbol: token?.symbol,
            entryPrice: position.entryPrice,
            currentPrice,
            amount: position.amount,
            valueUsd,
            pnlUsd: position.pnlUsd || pnlUsd,
            pnlPercent: position.pnlPercent || pnlPercent,
            timeHeld,
            status: position.status,
            exitStrategy,
            exitTrigger,
          };
        }),
      );

      this.positions = positionsWithDisplayData;
      this.sortAndUpdateTable();
      this.updateTitle();
    } catch (error) {
      this.handleError(error, 'Failed to refresh positions table');
    }
  }

  private formatExitStrategyName(strategy: ExitStrategyConfig): string {
    switch (strategy.type) {
      case 'profit':
        return 'Profit Target';
      case 'time':
        return 'Time Exit';
      case 'loss':
        return 'Stop Loss';
      case 'liquidity':
        return 'Liquidity Exit';
      case 'developer-activity':
        return 'Dev Activity';
      default:
        return strategy.name || strategy.type;
    }
  }

  private getExitTrigger(strategy: ExitStrategyConfig): string | undefined {
    switch (strategy.type) {
      case 'profit':
        return `+${(strategy.params as any).profitPercentage}%`;
      case 'time':
        return `${(strategy.params as any).timeMinutes}m`;
      case 'loss':
        return `-${(strategy.params as any).lossPercentage}%`;
      default:
        return undefined;
    }
  }

  public getSelectedPosition(): PositionDisplayData | null {
    // Mock implementation - return first position
    return this.positions[0] || null;
  }

  protected onFocus(): void {
    this.tableElement.focus();
  }
}

export default PositionsTable;
