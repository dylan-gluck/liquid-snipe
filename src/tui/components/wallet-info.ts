import blessed from 'blessed';
import { BaseComponent, ComponentConfig } from './base-component';
import { TuiTheme } from '../index';
import { DatabaseManager } from '../../db';

interface WalletBalance {
  token: string;
  symbol: string;
  balance: number;
  valueUsd: number;
  price: number;
}

interface WalletSummary {
  totalValueUsd: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  openPositions: number;
  todayTrades: number;
  balances: WalletBalance[];
}

export class WalletInfo extends BaseComponent {
  private walletSummary: WalletSummary = {
    totalValueUsd: 0,
    totalPnlUsd: 0,
    totalPnlPercent: 0,
    openPositions: 0,
    todayTrades: 0,
    balances: [],
  };

  constructor(
    private dbManager: DatabaseManager,
    theme: TuiTheme,
    config: ComponentConfig = {},
  ) {
    super(
      theme,
      {
        title: 'Wallet Overview',
        top: 0,
        left: 0,
        width: '100%',
        height: '50%',
        border: true,
        scrollable: true,
        ...config,
      },
      'WalletInfo',
    );
  }

  protected createElement(): void {
    super.createElement();

    // Set initial content
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const content = this.formatWalletDisplay();
    this.setContent(content);
  }

  private formatWalletDisplay(): string {
    // Safety check to ensure walletSummary is defined
    if (!this.walletSummary) {
      return '{red-fg}Wallet data not loaded{/red-fg}';
    }

    const { totalValueUsd, totalPnlUsd, totalPnlPercent, openPositions, todayTrades, balances } =
      this.walletSummary;

    // Portfolio summary section
    let content = `{bold}Portfolio Summary{/bold}\n`;
    content += `${'-'.repeat(20)}\n`;
    content += `Total Value:    ${this.formatCurrency(totalValueUsd)}\n`;
    content += `Today P&L:      ${this.colorizePositive(totalPnlUsd, this.formatCurrency(totalPnlUsd))}\n`;
    content += `Today P&L %:    ${this.colorizePositive(totalPnlPercent, this.formatPercent(totalPnlPercent))}\n`;
    content += `Open Positions: ${this.colorizeText(openPositions.toString(), 'info')}\n`;
    content += `Today Trades:   ${this.colorizeText(todayTrades.toString(), 'secondary')}\n\n`;

    // Balances section
    if (balances.length > 0) {
      content += `{bold}Token Balances{/bold}\n`;
      content += `${'-'.repeat(20)}\n`;

      // Sort balances by USD value (descending)
      const sortedBalances = [...balances].sort((a, b) => b.valueUsd - a.valueUsd);

      for (const balance of sortedBalances) {
        if (balance.valueUsd > 0.01) {
          // Only show meaningful balances
          content += `${balance.symbol.padEnd(8)} `;
          content += `${this.formatTokenAmount(balance.balance).padStart(12)} `;
          content += `${this.formatCurrency(balance.valueUsd).padStart(10)}\n`;
        }
      }
    } else {
      content += `{${this.theme.secondary}-fg}No token balances loaded{/}\n`;
    }

    return content;
  }

  private formatTokenAmount(amount: number): string {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(2)}K`;
    } else if (amount >= 1) {
      return amount.toFixed(2);
    } else {
      return amount.toFixed(6);
    }
  }

  public async refresh(): Promise<void> {
    try {
      await this.loadWalletData();
      this.updateDisplay();
    } catch (error) {
      this.handleError(error, 'Failed to refresh wallet info');
    }
  }

  private async loadWalletData(): Promise<void> {
    // Get open positions for portfolio summary
    const openPositions = await this.dbManager.getOpenPositions();

    // Get today's trades
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = 0; // Would need to implement getTradesSince method

    // Calculate portfolio values from positions
    let totalValueUsd = 0;
    let totalPnlUsd = 0;

    for (const position of openPositions) {
      // Mock current price calculation (in real implementation, would fetch from price service)
      const currentPrice = position.entryPrice * (1 + (Math.random() - 0.5) * 0.4);
      const currentValue = position.amount * currentPrice;
      const entryValue = position.amount * position.entryPrice;

      totalValueUsd += currentValue;
      totalPnlUsd += currentValue - entryValue;
    }

    const totalPnlPercent =
      totalValueUsd > 0 ? (totalPnlUsd / (totalValueUsd - totalPnlUsd)) * 100 : 0;

    // Mock wallet balances (in real implementation, would fetch from blockchain)
    const mockBalances: WalletBalance[] = [
      {
        token: 'So11111111111111111111111111111111111111112', // SOL
        symbol: 'SOL',
        balance: 12.5,
        price: 180.5,
        valueUsd: 12.5 * 180.5,
      },
      {
        token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        symbol: 'USDC',
        balance: 2450.75,
        price: 1.0,
        valueUsd: 2450.75,
      },
    ];

    // Add any tokens from open positions to balances
    const positionTokens = new Set(openPositions.map(p => p.tokenAddress));
    for (const tokenAddress of positionTokens) {
      const token = await this.dbManager.getToken(tokenAddress);
      if (token && !mockBalances.find(b => b.token === tokenAddress)) {
        // Find position for this token to get balance
        const position = openPositions.find(p => p.tokenAddress === tokenAddress);
        if (position) {
          const mockPrice = position.entryPrice * (1 + (Math.random() - 0.5) * 0.4);
          mockBalances.push({
            token: tokenAddress,
            symbol: token.symbol || 'UNKNOWN',
            balance: position.amount,
            price: mockPrice,
            valueUsd: position.amount * mockPrice,
          });
        }
      }
    }

    // Update total value to include base token balances
    const baseTokenValue = mockBalances
      .filter(b => ['SOL', 'USDC', 'USDT'].includes(b.symbol))
      .reduce((sum, b) => sum + b.valueUsd, 0);

    totalValueUsd += baseTokenValue;

    this.walletSummary = {
      totalValueUsd,
      totalPnlUsd,
      totalPnlPercent,
      openPositions: openPositions.length,
      todayTrades,
      balances: mockBalances,
    };
  }

  public getWalletSummary(): WalletSummary {
    return { ...this.walletSummary };
  }

  public getTotalValue(): number {
    return this.walletSummary.totalValueUsd;
  }

  public getTotalPnL(): { usd: number; percent: number } {
    return {
      usd: this.walletSummary.totalPnlUsd,
      percent: this.walletSummary.totalPnlPercent,
    };
  }

  public getTokenBalance(tokenAddress: string): WalletBalance | undefined {
    return this.walletSummary.balances.find(b => b.token === tokenAddress);
  }

  // Method to update specific token balance (for real-time updates)
  public updateTokenBalance(tokenAddress: string, balance: number, price: number): void {
    const existingIndex = this.walletSummary.balances.findIndex(b => b.token === tokenAddress);

    const tokenBalance: WalletBalance = {
      token: tokenAddress,
      symbol: tokenAddress.substring(0, 8), // Fallback symbol
      balance,
      price,
      valueUsd: balance * price,
    };

    if (existingIndex >= 0) {
      this.walletSummary.balances[existingIndex] = tokenBalance;
    } else {
      this.walletSummary.balances.push(tokenBalance);
    }

    // Recalculate total value
    this.recalculateTotals();
    this.updateDisplay();
  }

  private recalculateTotals(): void {
    this.walletSummary.totalValueUsd = this.walletSummary.balances.reduce(
      (sum, balance) => sum + balance.valueUsd,
      0,
    );
  }

  protected onResize(): void {
    // Handle component resize if needed
    this.updateDisplay();
  }
}

export default WalletInfo;
