import blessed from 'blessed';
import { DatabaseManager } from '../db';
import { EventProcessor } from '../events/types';
import { Logger } from '../utils/logger';
import { AppConfig } from '../types';
import { BaseComponent } from './components/base-component';
import { PoolsTable } from './components/pools-table';
import { PositionsTable } from './components/positions-table';
import { WalletInfo } from './components/wallet-info';
import { SystemStatus } from './components/system-status';
import { CommandInput } from './components/command-input';
import { LogViewer } from './components/log-viewer';

// Re-export TUI components
export * from './components';

export interface TuiTheme {
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  border: string;
  background: string;
  text: string;
}

export interface TuiLayout {
  header: blessed.Widgets.BoxElement;
  content: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
  sidebar: blessed.Widgets.BoxElement;
}

export class TuiController {
  private screen: blessed.Widgets.Screen;
  private layout!: TuiLayout;
  private components: Map<string, BaseComponent> = new Map();
  private currentView: string = 'pools';
  private logger: Logger;
  private refreshInterval: NodeJS.Timeout | null = null;
  private isVisible = true;

  private theme: TuiTheme = {
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

  constructor(
    private config: AppConfig,
    private dbManager: DatabaseManager,
    private eventProcessor: EventProcessor,
  ) {
    this.logger = new Logger('TuiController', { verbose: config.verbose });
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Liquid-Snipe',
      dockBorders: false,
      fullUnicode: true,
      autoPadding: false,
    });

    this.initializeLayout();
    this.initializeComponents();
    this.setupKeyBindings();
    this.setupEventListeners();
  }

  private initializeLayout(): void {
    // Main header
    this.layout = {} as TuiLayout;
    
    this.layout.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '',
      tags: true,
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
    });

    // Sidebar for status info
    this.layout.sidebar = blessed.box({
      top: 3,
      left: 0,
      width: '25%',
      height: '100%-6',
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
    });

    // Main content area
    this.layout.content = blessed.box({
      top: 3,
      left: '25%',
      width: '75%',
      height: '100%-6',
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
    });

    // Footer for commands and status
    this.layout.footer = blessed.box({
      top: '100%-3',
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
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
    });

    // Add all layout elements to screen
    this.screen.append(this.layout.header);
    this.screen.append(this.layout.sidebar);
    this.screen.append(this.layout.content);
    this.screen.append(this.layout.footer);
  }

  private initializeComponents(): void {
    // Create and register components
    const poolsTable = new PoolsTable(this.dbManager, this.theme);
    const positionsTable = new PositionsTable(this.dbManager, this.theme);
    const walletInfo = new WalletInfo(this.dbManager, this.theme);
    const systemStatus = new SystemStatus(this.eventProcessor, this.theme);
    const commandInput = new CommandInput(this.theme, this.handleCommand.bind(this));
    const logViewer = new LogViewer(this.dbManager, this.theme);

    this.components.set('pools', poolsTable);
    this.components.set('positions', positionsTable);
    this.components.set('wallet', walletInfo);
    this.components.set('status', systemStatus);
    this.components.set('command', commandInput);
    this.components.set('logs', logViewer);

    // Mount components
    this.layout.sidebar.append(walletInfo.getElement());
    this.layout.sidebar.append(systemStatus.getElement());
    this.layout.content.append(poolsTable.getElement());
    this.layout.content.append(positionsTable.getElement());
    this.layout.content.append(logViewer.getElement());
    this.layout.footer.append(commandInput.getElement());

    // Show initial view
    this.switchView('pools');
  }

  private setupKeyBindings(): void {
    // Quit application
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.logger.info('User requested application exit');
      this.stop();
      process.exit(0);
    });

    // Switch between views
    this.screen.key(['1'], () => this.switchView('pools'));
    this.screen.key(['2'], () => this.switchView('positions'));
    this.screen.key(['3'], () => this.switchView('logs'));

    // Refresh data
    this.screen.key(['r', 'F5'], () => {
      this.refreshAllComponents();
    });

    // Focus command input
    this.screen.key(['/', ':'], () => {
      const commandComponent = this.components.get('command');
      if (commandComponent && commandComponent instanceof CommandInput) {
        commandComponent.focus();
      }
    });

    // Help
    this.screen.key(['h', 'F1'], () => {
      this.showHelp();
    });

    // Pause/Resume (toggle dry run)
    this.screen.key(['p'], () => {
      this.toggleDryRun();
    });
  }

  private setupEventListeners(): void {
    // Listen for various events to update the UI
    this.eventProcessor.on('newPool', () => {
      if (this.currentView === 'pools') {
        const poolsComponent = this.components.get('pools');
        if (poolsComponent) {
          poolsComponent.refresh();
        }
      }
    });

    this.eventProcessor.on('positionUpdate', () => {
      const positionsComponent = this.components.get('positions');
      if (positionsComponent) {
        positionsComponent.refresh();
      }
    });

    this.eventProcessor.on('walletUpdate', () => {
      const walletComponent = this.components.get('wallet');
      if (walletComponent) {
        walletComponent.refresh();
      }
    });

    this.eventProcessor.on('systemStatus', () => {
      const statusComponent = this.components.get('status');
      if (statusComponent) {
        statusComponent.refresh();
      }
    });

    this.eventProcessor.on('log', () => {
      if (this.currentView === 'logs') {
        const logsComponent = this.components.get('logs');
        if (logsComponent) {
          logsComponent.refresh();
        }
      }
    });
  }

  private switchView(viewName: string): void {
    // Hide all content components first
    this.components.forEach((component, name) => {
      if (['pools', 'positions', 'logs'].includes(name)) {
        component.hide();
      }
    });

    // Show the requested view
    const component = this.components.get(viewName);
    if (component) {
      component.show();
      component.refresh();
      this.currentView = viewName;
    }

    this.updateHeader();
    this.updateFooter();
    this.screen.render();
  }

  private updateHeader(): void {
    const statusComponent = this.components.get('status') as SystemStatus;
    const statusInfo = statusComponent ? statusComponent.getStatusSummary() : { status: 'Unknown', connections: 0 };
    
    const title = `{bold}🚀 Liquid-Snipe{/bold}`;
    const status = this.config.dryRun ? 
      `{${this.theme.warning}-fg}[DRY RUN]{/}` : 
      `{${this.theme.success}-fg}[ACTIVE]{/}`;
    const connections = `{${this.theme.info}-fg}Connections: ${statusInfo.connections}{/}`;
    const currentTime = new Date().toLocaleTimeString();

    this.layout.header.setContent(
      `${title} ${status} | ${connections} | {${this.theme.secondary}-fg}${currentTime}{/}`
    );
  }

  private updateFooter(): void {
    const viewName = this.currentView.charAt(0).toUpperCase() + this.currentView.slice(1);
    const keyBindings = [
      `{${this.theme.primary}-fg}1{/} Pools`,
      `{${this.theme.primary}-fg}2{/} Positions`, 
      `{${this.theme.primary}-fg}3{/} Logs`,
      `{${this.theme.primary}-fg}R{/} Refresh`,
      `{${this.theme.primary}-fg}P{/} Pause/Resume`,
      `{${this.theme.primary}-fg}H{/} Help`,
      `{${this.theme.primary}-fg}Q{/} Quit`,
    ].join(' | ');

    this.layout.footer.setContent(
      `{bold}${viewName}{/bold} | ${keyBindings}`
    );
  }

  private async handleCommand(command: string): Promise<void> {
    const parts = command.trim().split(' ');
    const cmd = parts[0].toLowerCase();

    this.logger.info(`Executing command: ${command}`);

    try {
      switch (cmd) {
        case 'help':
          this.showHelp();
          break;
        case 'refresh':
          this.refreshAllComponents();
          break;
        case 'clear':
          this.clearLogs();
          break;
        case 'stats':
          await this.showStats();
          break;
        case 'switch':
        case 'view':
          if (parts[1]) {
            this.switchView(parts[1]);
          }
          break;
        default:
          this.logger.warning(`Unknown command: ${cmd}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Command execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private showHelp(): void {
    const helpText = `
{bold}Liquid-Snipe Help{/bold}

{underline}Key Bindings:{/underline}
  1, 2, 3     - Switch between views (Pools, Positions, Logs)
  R, F5       - Refresh current view
  P           - Toggle Pause/Resume (dry run mode)
  /, :        - Focus command input
  H, F1       - Show this help
  Q, Esc      - Quit application

{underline}Commands:{/underline}
  help        - Show this help
  refresh     - Refresh all data
  clear       - Clear log display
  stats       - Show database statistics
  view <name> - Switch to view (pools, positions, logs)

{underline}Views:{/underline}
  Pools       - New liquidity pools detected
  Positions   - Open and closed trading positions
  Logs        - System logs and events

Press any key to close this help...
    `;

    const helpBox = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '70%',
      content: helpText,
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

    helpBox.focus();
    this.screen.render();

    helpBox.key(['escape', 'enter', 'space'], () => {
      helpBox.destroy();
      this.screen.render();
    });
  }

  private async showStats(): Promise<void> {
    try {
      const stats = await this.dbManager.getStats();
      const statsText = `
{bold}Database Statistics{/bold}

Tokens:           ${stats.tokenCount}
Pools:            ${stats.poolCount}
Trades:           ${stats.tradeCount}
Open Positions:   ${stats.openPositionCount}
Closed Positions: ${stats.closedPositionCount}
Database Size:    ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB

Press any key to close...
      `;

      const statsBox = blessed.message({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: '40%',
        height: '50%',
        content: statsText,
        tags: true,
        border: {
          type: 'line',
        },
        style: {
          border: {
            fg: this.theme.info,
          },
          bg: this.theme.background,
          fg: this.theme.text,
        },
      });

      statsBox.focus();
      this.screen.render();

      statsBox.key(['escape', 'enter', 'space'], () => {
        statsBox.destroy();
        this.screen.render();
      });
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toggleDryRun(): void {
    this.config.dryRun = !this.config.dryRun;
    this.logger.info(`Dry run mode ${this.config.dryRun ? 'enabled' : 'disabled'}`);
    this.updateHeader();
    this.screen.render();
  }

  private clearLogs(): void {
    const logsComponent = this.components.get('logs') as LogViewer;
    if (logsComponent) {
      logsComponent.clear();
    }
  }

  private refreshAllComponents(): void {
    this.components.forEach(component => {
      component.refresh();
    });
    this.updateHeader();
    this.updateFooter();
    this.screen.render();
  }

  public start(): void {
    this.logger.info('Starting TUI');
    
    // Initial render
    this.updateHeader();
    this.updateFooter();
    this.refreshAllComponents();
    this.screen.render();

    // Set up refresh interval
    this.refreshInterval = setInterval(() => {
      if (this.isVisible) {
        this.refreshAllComponents();
      }
    }, 5000); // Refresh every 5 seconds

    this.logger.info('TUI started successfully');
  }

  public stop(): void {
    this.logger.info('Stopping TUI');
    
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    this.isVisible = false;
    
    // Clean up components
    this.components.forEach(component => {
      if (typeof component.destroy === 'function') {
        component.destroy();
      }
    });

    this.screen.destroy();
    this.logger.info('TUI stopped');
  }

  public hide(): void {
    this.isVisible = false;
    // Screen hide/show methods don't exist in blessed types
    // this.screen.hide();
  }

  public show(): void {
    this.isVisible = true;
    // this.screen.show();
    this.screen.render();
  }

  public isRunning(): boolean {
    return this.isVisible;
  }
}

export default TuiController;