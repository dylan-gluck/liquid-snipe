import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';
import { DatabaseManager } from '../../db';
import { LiquidityPool, Token } from '../../types';

interface PoolDisplayData {
  address: string;
  dex: string;
  tokenA: string;
  tokenB: string;
  tokenASymbol?: string;
  tokenBSymbol?: string;
  initialLiquidity: number;
  currentLiquidity: number;
  age: string;
  status: string;
  liquidityChange: number;
}

export class PoolsTable extends BaseComponent {
  private tableElement!: blessed.Widgets.ListTableElement;
  private pools: PoolDisplayData[] = [];
  private sortColumn = 'age';
  private sortDirection: 'asc' | 'desc' = 'desc';
  private filterText = '';

  constructor(
    private dbManager: DatabaseManager,
    theme: TuiTheme,
    config: ComponentConfig = {},
  ) {
    super(theme, {
      title: 'Detected Liquidity Pools',
      ...config,
    }, 'PoolsTable');

    this.createTableElement();
    this.setupTableEventHandlers();
  }

  protected createElement(): void {
    super.createElement();
    
    // Create container for the table
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

    // Set table headers
    this.updateTableHeaders();
  }

  private setupTableEventHandlers(): void {
    // Sort by column when header is clicked
    this.tableElement.on('select', (item, index) => {
      if (index === 0) {
        // Header row clicked - cycle through sort options
        this.cycleSortColumn();
      } else {
        // Data row clicked - show pool details
        this.showPoolDetails(index - 1);
      }
    });

    // Keyboard shortcuts for table
    this.tableElement.key(['s'], () => {
      this.cycleSortColumn();
    });

    this.tableElement.key(['f'], () => {
      this.showFilterDialog();
    });

    this.tableElement.key(['r'], () => {
      this.refresh();
    });
  }

  private updateTableHeaders(): void {
    const headers = [
      'Time',
      'DEX',
      'Token A',
      'Token B',
      'Initial Liq.',
      'Current Liq.',
      'Change',
      'Status',
    ];

    // Add sort indicators
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
      'Time': 'age',
      'DEX': 'dex',
      'Token A': 'tokenA',
      'Token B': 'tokenB',
      'Initial Liq.': 'initialLiquidity',
      'Current Liq.': 'currentLiquidity',
      'Change': 'liquidityChange',
      'Status': 'status',
    };
    return columnMap[header] || header.toLowerCase();
  }

  private cycleSortColumn(): void {
    const columns = ['age', 'dex', 'initialLiquidity', 'currentLiquidity', 'liquidityChange'];
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
    this.sortPools();
    this.updateTableData();
    this.updateTableHeaders();
    this.tableElement.screen?.render();
  }

  private sortPools(): void {
    this.pools.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (this.sortColumn) {
        case 'age':
          // Sort by creation time (newer first for desc)
          aVal = new Date().getTime() - this.parseAge(a.age);
          bVal = new Date().getTime() - this.parseAge(b.age);
          break;
        case 'dex':
          aVal = a.dex;
          bVal = b.dex;
          break;
        case 'initialLiquidity':
          aVal = a.initialLiquidity;
          bVal = b.initialLiquidity;
          break;
        case 'currentLiquidity':
          aVal = a.currentLiquidity;
          bVal = b.currentLiquidity;
          break;
        case 'liquidityChange':
          aVal = a.liquidityChange;
          bVal = b.liquidityChange;
          break;
        default:
          aVal = a.status;
          bVal = b.status;
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

  private parseAge(ageStr: string): number {
    // Convert age string like "5m 30s" to milliseconds
    const parts = ageStr.split(' ');
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
    const filteredPools = this.filterPools();
    
    const tableData = filteredPools.map(pool => [
      pool.age,
      pool.dex,
      pool.tokenASymbol || this.formatAddress(pool.tokenA),
      pool.tokenBSymbol || this.formatAddress(pool.tokenB),
      this.formatLiquidity(pool.initialLiquidity),
      this.formatLiquidity(pool.currentLiquidity),
      this.formatLiquidityChange(pool.liquidityChange),
      this.colorizeStatus(pool.status),
    ]);

    // Combine headers with data
    const headers = [
      'Time',
      'DEX',
      'Token A',
      'Token B',
      'Initial Liq.',
      'Current Liq.',
      'Change',
      'Status',
    ];

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

  private filterPools(): PoolDisplayData[] {
    if (!this.filterText) {
      return this.pools;
    }

    const filterLower = this.filterText.toLowerCase();
    return this.pools.filter(pool => 
      pool.dex.toLowerCase().includes(filterLower) ||
      pool.tokenASymbol?.toLowerCase().includes(filterLower) ||
      pool.tokenBSymbol?.toLowerCase().includes(filterLower) ||
      pool.address.toLowerCase().includes(filterLower)
    );
  }

  private formatAddress(address: string): string {
    return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
  }

  private formatLiquidity(amount: number): string {
    if (amount >= 1000000) {
      return `$${(amount / 1000000).toFixed(1)}M`;
    } else if (amount >= 1000) {
      return `$${(amount / 1000).toFixed(1)}K`;
    } else {
      return this.formatCurrency(amount);
    }
  }

  private formatLiquidityChange(change: number): string {
    const formatted = this.formatPercent(change);
    return this.colorizePositive(change, formatted);
  }

  private showPoolDetails(index: number): void {
    const pool = this.filterPools()[index];
    if (!pool) return;

    const detailsText = `
{bold}Pool Details{/bold}

Address:         ${pool.address}
DEX:            ${pool.dex}
Token A:        ${pool.tokenA}
                ${pool.tokenASymbol || 'Unknown Symbol'}
Token B:        ${pool.tokenB}
                ${pool.tokenBSymbol || 'Unknown Symbol'}
Initial Liq.:   ${this.formatCurrency(pool.initialLiquidity)}
Current Liq.:   ${this.formatCurrency(pool.currentLiquidity)}
Change:         ${this.formatLiquidityChange(pool.liquidityChange)}
Age:            ${pool.age}
Status:         ${pool.status}

Press any key to close...
    `;

    const detailsBox = blessed.message({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '70%',
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

  private showFilterDialog(): void {
    const filterBox = blessed.textbox({
      parent: this.element.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 3,
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
      label: ' Filter Pools ',
      value: this.filterText,
    });

    filterBox.focus();
    this.element.screen?.render();

    filterBox.on('submit', (value: string) => {
      this.filterText = value || '';
      this.updateTableData();
      filterBox.destroy();
      this.tableElement.focus();
      this.element.screen?.render();
    });

    filterBox.key(['escape'], () => {
      filterBox.destroy();
      this.tableElement.focus();
      this.element.screen?.render();
    });
  }

  public async refresh(): Promise<void> {
    try {
      // Fetch pools from database
      const pools = await this.dbManager.getLiquidityPools();
      
      // Get token information for better display
      const poolsWithTokenInfo = await Promise.all(
        pools.map(async (pool) => {
          const [tokenA, tokenB] = await Promise.all([
            this.dbManager.getToken(pool.tokenA),
            this.dbManager.getToken(pool.tokenB),
          ]);

          const age = this.formatDuration(pool.createdAt);
          const liquidityChange = pool.initialLiquidityUsd > 0 
            ? ((pool.currentLiquidityUsd - pool.initialLiquidityUsd) / pool.initialLiquidityUsd) * 100
            : 0;

          let status = 'Active';
          if (pool.currentLiquidityUsd < pool.initialLiquidityUsd * 0.5) {
            status = 'Low Liquidity';
          } else if (pool.currentLiquidityUsd > pool.initialLiquidityUsd * 2) {
            status = 'High Growth';
          }

          return {
            address: pool.address,
            dex: pool.dexName,
            tokenA: pool.tokenA,
            tokenB: pool.tokenB,
            tokenASymbol: tokenA?.symbol,
            tokenBSymbol: tokenB?.symbol,
            initialLiquidity: pool.initialLiquidityUsd,
            currentLiquidity: pool.currentLiquidityUsd,
            age,
            status,
            liquidityChange,
          };
        })
      );

      this.pools = poolsWithTokenInfo;
      this.sortAndUpdateTable();
      
      // Update title with count
      this.setTitle(`Detected Liquidity Pools (${this.pools.length})`);
      
    } catch (error) {
      this.handleError(error, 'Failed to refresh pools table');
    }
  }

  public clearFilter(): void {
    this.filterText = '';
    this.updateTableData();
    this.element.screen?.render();
  }

  public getSelectedPool(): PoolDisplayData | null {
    // Note: blessed.listtable doesn't have a 'selected' property in types
    // This would need to be implemented differently or use a different approach
    const filteredPools = this.filterPools();
    return filteredPools[0] || null; // Return first pool for now
  }

  protected onFocus(): void {
    this.tableElement.focus();
  }
}

export default PoolsTable;