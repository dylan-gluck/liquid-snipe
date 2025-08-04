import { Logger } from '../../utils/logger';
import { EventManager } from '../../events/event-manager';
import { AppConfig } from '../../types';
import DatabaseManager from '../../db';

export interface UserCommand {
  type:
    | 'EXIT_POSITION'
    | 'CHANGE_STRATEGY'
    | 'MANUAL_TRADE'
    | 'PAUSE_TRADING'
    | 'RESUME_TRADING'
    | 'EXPORT_DATA'
    | 'VIEW_STATUS'
    | 'HELP';
  parameters: Record<string, any>;
  timestamp: number;
  userId?: string;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
  timestamp: number;
}

export interface UserInteractionWorkflowState {
  commandProcessing: 'IDLE' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  lastCommand?: UserCommand;
  lastResult?: CommandResult;
}

export class UserInteractionWorkflowCoordinator {
  private logger: Logger;
  private workflowState: UserInteractionWorkflowState = {
    commandProcessing: 'IDLE',
  };

  constructor(
    private eventManager: EventManager,
    private dbManager: DatabaseManager,
    private config: AppConfig,
  ) {
    this.logger = new Logger('UserInteractionWorkflow');
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle user commands
    this.eventManager.on('userCommand', async (command: UserCommand) => {
      await this.handleUserCommand(command);
    });

    // Handle TUI commands
    this.eventManager.on('tuiCommand', async (command: UserCommand) => {
      await this.handleUserCommand(command);
    });
  }

  private async handleUserCommand(command: UserCommand): Promise<void> {
    this.logger.info(`Processing user command: ${command.type}`);

    this.workflowState = {
      commandProcessing: 'PROCESSING',
      lastCommand: command,
    };

    try {
      const result = await this.executeCommand(command);

      this.workflowState = {
        commandProcessing: 'COMPLETED',
        lastCommand: command,
        lastResult: result,
      };

      // Emit result back to user interface
      this.eventManager.emit('commandResult', result);

      this.logger.info(`Command completed: ${command.type} - ${result.message}`);
    } catch (error) {
      const errorResult: CommandResult = {
        success: false,
        message: `Command failed: ${(error as Error).message}`,
        timestamp: Date.now(),
      };

      this.workflowState = {
        commandProcessing: 'FAILED',
        lastCommand: command,
        lastResult: errorResult,
      };

      this.eventManager.emit('commandResult', errorResult);
      this.logger.error(`Command failed: ${command.type} - ${(error as Error).message}`);
    }
  }

  private async executeCommand(command: UserCommand): Promise<CommandResult> {
    switch (command.type) {
      case 'EXIT_POSITION':
        return await this.handleExitPositionCommand(command);

      case 'CHANGE_STRATEGY':
        return await this.handleChangeStrategyCommand(command);

      case 'MANUAL_TRADE':
        return await this.handleManualTradeCommand(command);

      case 'PAUSE_TRADING':
        return await this.handlePauseTradingCommand(command);

      case 'RESUME_TRADING':
        return await this.handleResumeTradingCommand(command);

      case 'EXPORT_DATA':
        return await this.handleExportDataCommand(command);

      case 'VIEW_STATUS':
        return await this.handleViewStatusCommand(command);

      case 'HELP':
        return await this.handleHelpCommand(command);

      default:
        throw new Error(`Unknown command type: ${command.type}`);
    }
  }

  private async handleExitPositionCommand(command: UserCommand): Promise<CommandResult> {
    const { positionId, reason = 'Manual exit requested' } = command.parameters;

    if (!positionId) {
      throw new Error('Position ID is required for exit command');
    }

    // Emit exit request event
    this.eventManager.emit('exitRequest', {
      positionId,
      reason,
      urgency: 'MEDIUM',
    });

    return {
      success: true,
      message: `Exit request submitted for position ${positionId}`,
      timestamp: Date.now(),
    };
  }

  private async handleChangeStrategyCommand(command: UserCommand): Promise<CommandResult> {
    const { positionId, strategyName } = command.parameters;

    if (!positionId || !strategyName) {
      throw new Error('Position ID and strategy name are required');
    }

    // Find the strategy in configuration
    const strategy = this.config.exitStrategies.find(s => s.name === strategyName);
    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyName}`);
    }

    // Update position strategy (this would be implemented in PositionManager)
    // For now, just emit an event
    this.eventManager.emit('strategyChange', {
      positionId,
      newStrategy: strategy,
    });

    return {
      success: true,
      message: `Strategy changed to ${strategyName} for position ${positionId}`,
      timestamp: Date.now(),
    };
  }

  private async handleManualTradeCommand(command: UserCommand): Promise<CommandResult> {
    const { tokenAddress, amount, direction = 'BUY' } = command.parameters;

    if (!tokenAddress || !amount) {
      throw new Error('Token address and amount are required for manual trade');
    }

    // Create manual trade decision
    const tradeDecision = {
      shouldTrade: true,
      targetToken: tokenAddress,
      baseToken: 'USDC', // Default base token
      poolAddress: 'MANUAL_TRADE', // Placeholder
      tradeAmountUsd: amount,
      reason: 'Manual trade requested',
      riskScore: 5, // Medium risk for manual trades
    };

    this.eventManager.emit('tradeDecision', tradeDecision);

    return {
      success: true,
      message: `Manual ${direction} trade submitted for ${tokenAddress}`,
      timestamp: Date.now(),
    };
  }

  private async handlePauseTradingCommand(command: UserCommand): Promise<CommandResult> {
    // Emit system control event
    this.eventManager.emit('systemControl', {
      action: 'PAUSE_TRADING',
      timestamp: Date.now(),
    });

    return {
      success: true,
      message: 'Trading paused',
      timestamp: Date.now(),
    };
  }

  private async handleResumeTradingCommand(command: UserCommand): Promise<CommandResult> {
    // Emit system control event
    this.eventManager.emit('systemControl', {
      action: 'RESUME_TRADING',
      timestamp: Date.now(),
    });

    return {
      success: true,
      message: 'Trading resumed',
      timestamp: Date.now(),
    };
  }

  private async handleExportDataCommand(command: UserCommand): Promise<CommandResult> {
    const { format = 'json', path, dataType = 'all' } = command.parameters;

    try {
      let data: any = {};

      switch (dataType) {
        case 'positions':
          data.positions = await this.dbManager.getAllPositions();
          break;
        case 'trades':
          data.trades = await this.dbManager.getAllTrades();
          break;
        case 'pools':
          data.pools = await this.dbManager.getAllPools();
          break;
        default:
          data = {
            positions: await this.dbManager.getAllPositions(),
            trades: await this.dbManager.getAllTrades(),
            pools: await this.dbManager.getAllPools(),
          };
      }

      // In a real implementation, you would save to file
      // For now, just return the data
      return {
        success: true,
        message: `Data exported successfully (${format} format)`,
        data,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new Error(`Export failed: ${(error as Error).message}`);
    }
  }

  private async handleViewStatusCommand(command: UserCommand): Promise<CommandResult> {
    try {
      const openPositions = await this.dbManager.getOpenPositions();
      const recentTrades = await this.dbManager.getRecentTrades(10);

      const status = {
        openPositions: openPositions.length,
        recentTradesCount: recentTrades.length,
        systemStatus: 'RUNNING',
        dryRun: this.config.dryRun,
        enabledDexes: this.config.supportedDexes.filter(d => d.enabled).length,
      };

      return {
        success: true,
        message: 'System status retrieved',
        data: status,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new Error(`Status retrieval failed: ${(error as Error).message}`);
    }
  }

  private async handleHelpCommand(command: UserCommand): Promise<CommandResult> {
    const helpText = `
Available Commands:
- exit <positionId> - Exit a specific position
- strategy <positionId> <strategyName> - Change exit strategy for a position
- trade <tokenAddress> <amount> - Execute manual trade
- pause - Pause automatic trading
- resume - Resume automatic trading
- export [format] [dataType] - Export data (json/csv, all/positions/trades/pools)
- status - View system status
- help - Show this help message
    `.trim();

    return {
      success: true,
      message: helpText,
      timestamp: Date.now(),
    };
  }

  public getWorkflowState(): UserInteractionWorkflowState {
    return { ...this.workflowState };
  }

  public isProcessing(): boolean {
    return this.workflowState.commandProcessing === 'PROCESSING';
  }
}
