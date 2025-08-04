import { Logger } from '../../utils/logger';
import { EventManager } from '../../events/event-manager';
import { TradeResult } from '../../types';
import { PositionManager } from '../../trading/position-manager';
import DatabaseManager from '../../db';

export interface PositionWorkflowState {
  monitoring: 'ACTIVE' | 'PAUSED' | 'STOPPED';
  exitEvaluation: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  exitExecution: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
}

export interface ExitRequest {
  positionId: string;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  partialExitPercentage?: number;
}

export class PositionWorkflowCoordinator {
  private logger: Logger;
  private activePositionWorkflows = new Map<string, PositionWorkflowState>();
  private monitoringInterval?: NodeJS.Timeout;
  private isMonitoring = false;

  constructor(
    private eventManager: EventManager,
    private positionManager: PositionManager,
    private dbManager: DatabaseManager,
    private isDryRun: boolean = false,
    private monitoringIntervalMs: number = 60000, // 1 minute
  ) {
    this.logger = new Logger('PositionWorkflow');
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle new positions from trade results
    this.eventManager.on('tradeResult', async (result: TradeResult) => {
      if (result.success && result.positionId) {
        await this.handleNewPosition(result.positionId);
      }
    });

    // Handle position update events
    this.eventManager.on('positionUpdate', async (update: any) => {
      await this.handlePositionUpdate(update);
    });

    // Handle exit requests
    this.eventManager.on('exitRequest', async (request: ExitRequest) => {
      await this.handleExitRequest(request);
    });
  }

  public async startPositionMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warning('Position monitoring is already active');
      return;
    }

    this.logger.info('Starting position monitoring workflow...');
    this.isMonitoring = true;

    // Start monitoring interval
    this.monitoringInterval = setInterval(async () => {
      await this.executeMonitoringCycle();
    }, this.monitoringIntervalMs);

    // Run initial monitoring cycle
    await this.executeMonitoringCycle();
  }

  public stopPositionMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.logger.info('Stopping position monitoring workflow...');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.isMonitoring = false;

    // Update all active workflows to stopped
    for (const [positionId] of this.activePositionWorkflows) {
      this.updateWorkflowState(positionId, { monitoring: 'STOPPED' });
    }
  }

  private async executeMonitoringCycle(): Promise<void> {
    try {
      this.logger.debug('Executing position monitoring cycle...');

      // Get all open positions
      const openPositions = await this.dbManager.getOpenPositions();

      this.logger.debug(`Monitoring ${openPositions.length} open positions`);

      for (const position of openPositions) {
        try {
          await this.evaluatePositionForExit(position.id);
        } catch (error) {
          this.logger.error(
            `Error evaluating position ${position.id}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Position monitoring cycle failed: ${(error as Error).message}`);
    }
  }

  private async handleNewPosition(positionId: string): Promise<void> {
    this.logger.info(`Starting position workflow for: ${positionId}`);

    // Initialize workflow state
    this.activePositionWorkflows.set(positionId, {
      monitoring: 'ACTIVE',
      exitEvaluation: 'PENDING',
      exitExecution: 'PENDING',
    });

    this.logger.debug(`Position workflow initialized for: ${positionId}`);
  }

  private async handlePositionUpdate(update: any): Promise<void> {
    this.logger.debug('Position update received:', update);
    // Handle position updates (price changes, liquidity changes, etc.)
    // This would trigger re-evaluation of exit conditions
  }

  private async evaluatePositionForExit(positionId: string): Promise<void> {
    // Ensure workflow exists
    if (!this.activePositionWorkflows.has(positionId)) {
      await this.handleNewPosition(positionId);
    }

    this.updateWorkflowState(positionId, { exitEvaluation: 'IN_PROGRESS' });

    try {
      // Get position details
      const position = await this.positionManager.getPosition(positionId);
      if (!position) {
        this.logger.warning(`Position not found: ${positionId}`);
        this.cleanupWorkflow(positionId);
        return;
      }

      // For now, use placeholder current price - in real implementation,
      // this would come from the token info service or price oracle
      const currentPrice = {
        tokenAddress: position.tokenAddress,
        price: position.entryPrice * (0.9 + Math.random() * 0.2), // Simulate price movement
        timestamp: Date.now(),
        source: 'placeholder',
      };

      // Evaluate exit conditions
      const exitResult = this.positionManager.evaluateExitConditions(position, currentPrice);

      this.updateWorkflowState(positionId, { exitEvaluation: 'COMPLETED' });

      if (exitResult.shouldExit) {
        this.logger.info(`Exit condition met for position ${positionId}: ${exitResult.reason}`);

        await this.handleExitRequest({
          positionId,
          reason: exitResult.reason,
          urgency: exitResult.urgency,
          partialExitPercentage: exitResult.partialExitPercentage,
        });
      }
    } catch (error) {
      this.logger.error(
        `Position evaluation failed for ${positionId}: ${(error as Error).message}`,
      );
      this.updateWorkflowState(positionId, { exitEvaluation: 'FAILED' });
    }
  }

  private async handleExitRequest(request: ExitRequest): Promise<void> {
    const { positionId, reason, urgency, partialExitPercentage } = request;

    this.logger.info(`Processing exit request for position ${positionId}: ${reason}`);
    this.updateWorkflowState(positionId, { exitExecution: 'IN_PROGRESS' });

    try {
      if (this.isDryRun) {
        this.logger.info(`[DRY RUN] Would exit position ${positionId} (${reason})`);
        this.updateWorkflowState(positionId, { exitExecution: 'COMPLETED' });
        this.cleanupWorkflow(positionId);
        return;
      }

      // Execute the position exit
      await this.positionManager.processExitRequest({
        positionId,
        reason,
        urgency,
        partialExitPercentage,
      });

      this.updateWorkflowState(positionId, { exitExecution: 'COMPLETED' });
      this.logger.info(`Position exit completed: ${positionId}`);

      // Cleanup completed workflow
      this.cleanupWorkflow(positionId);
    } catch (error) {
      this.logger.error(`Position exit failed for ${positionId}: ${(error as Error).message}`);
      this.updateWorkflowState(positionId, { exitExecution: 'FAILED' });
    }
  }

  private updateWorkflowState(positionId: string, updates: Partial<PositionWorkflowState>): void {
    const currentState = this.activePositionWorkflows.get(positionId);
    if (currentState) {
      this.activePositionWorkflows.set(positionId, { ...currentState, ...updates });
      this.logger.debug(`Position workflow ${positionId} state updated:`, updates);
    }
  }

  private cleanupWorkflow(positionId: string): void {
    this.activePositionWorkflows.delete(positionId);
    this.logger.debug(`Cleaned up position workflow: ${positionId}`);
  }

  public getActiveWorkflows(): Map<string, PositionWorkflowState> {
    return new Map(this.activePositionWorkflows);
  }

  public getWorkflowState(positionId: string): PositionWorkflowState | null {
    return this.activePositionWorkflows.get(positionId) || null;
  }

  public pausePositionMonitoring(positionId: string): void {
    this.updateWorkflowState(positionId, { monitoring: 'PAUSED' });
    this.logger.info(`Position monitoring paused for: ${positionId}`);
  }

  public resumePositionMonitoring(positionId: string): void {
    this.updateWorkflowState(positionId, { monitoring: 'ACTIVE' });
    this.logger.info(`Position monitoring resumed for: ${positionId}`);
  }
}
