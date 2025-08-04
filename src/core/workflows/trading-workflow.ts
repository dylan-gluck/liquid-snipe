import { Logger } from '../../utils/logger';
import { EventManager } from '../../events/event-manager';
import { NewPoolEvent, TradeDecision, TradeResult } from '../../types';
import { StrategyEngine } from '../../trading/strategy-engine';
import { TradeExecutor } from '../../trading/trade-executor';
import DatabaseManager from '../../db';
import { TradingStateMachine, TradingStateTransition } from '../state-machines/trading-state-machine';

export interface TradingWorkflowState {
  poolEvaluation: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  tradeDecision: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  tradeExecution: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
}

export class TradingWorkflowCoordinator {
  private logger: Logger;
  private activeWorkflows = new Map<string, TradingWorkflowState>();
  private activeStateMachines = new Map<string, TradingStateMachine>();

  constructor(
    private eventManager: EventManager,
    private strategyEngine: StrategyEngine,
    private tradeExecutor: TradeExecutor,
    private dbManager: DatabaseManager,
    private isDryRun: boolean = false
  ) {
    this.logger = new Logger('TradingWorkflow');
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle new pool events
    this.eventManager.on('newPool', async (poolEvent: NewPoolEvent) => {
      await this.handleNewPoolWorkflow(poolEvent);
    });

    // Handle trade decisions
    this.eventManager.on('tradeDecision', async (decision: TradeDecision) => {
      await this.handleTradeDecisionWorkflow(decision);  
    });

    // Handle trade results
    this.eventManager.on('tradeResult', async (result: TradeResult) => {
      await this.handleTradeResultWorkflow(result);
    });
  }

  private async handleNewPoolWorkflow(poolEvent: NewPoolEvent): Promise<void> {
    const workflowId = `pool_${poolEvent.signature}`;
    
    this.logger.info(`Starting trading workflow for pool: ${poolEvent.poolAddress}`);

    // Initialize state machine
    const stateMachine = new TradingStateMachine();
    stateMachine.transition(TradingStateTransition.POOL_DETECTED, {
      poolAddress: poolEvent.poolAddress,
      tokenAddress: poolEvent.tokenA // Assume tokenA is the new token
    });
    this.activeStateMachines.set(workflowId, stateMachine);

    // Initialize workflow state
    this.activeWorkflows.set(workflowId, {
      poolEvaluation: 'PENDING',
      tradeDecision: 'PENDING', 
      tradeExecution: 'PENDING'
    });

    try {
      // Step 1: Pool evaluation
      this.updateWorkflowState(workflowId, { poolEvaluation: 'IN_PROGRESS' });
      stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED);
      
      const decision = await this.strategyEngine.evaluatePool(poolEvent);
      
      this.updateWorkflowState(workflowId, { poolEvaluation: 'COMPLETED' });
      
      if (decision) {
        stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED, {
          tradeAmount: decision.tradeAmountUsd
        });
      } else {
        stateMachine.transition(TradingStateTransition.EVALUATION_COMPLETED);
      }

      // Step 2: Trade decision processing
      if (decision) {
        this.updateWorkflowState(workflowId, { tradeDecision: 'IN_PROGRESS' });
        this.eventManager.emit('tradeDecision', decision);
        this.updateWorkflowState(workflowId, { tradeDecision: 'COMPLETED' });
      } else {
        this.updateWorkflowState(workflowId, { tradeDecision: 'SKIPPED' });
        this.logger.info(`Pool ${poolEvent.poolAddress} evaluation completed - no trade recommended`);
        this.cleanupWorkflow(workflowId);
      }

    } catch (error) {
      this.logger.error(`Pool evaluation workflow failed: ${(error as Error).message}`);
      this.updateWorkflowState(workflowId, { poolEvaluation: 'FAILED' });
      this.cleanupWorkflow(workflowId);
    }
  }

  private async handleTradeDecisionWorkflow(decision: TradeDecision): Promise<void> {
    const workflowId = this.findWorkflowByToken(decision.targetToken);
    
    if (!workflowId) {
      this.logger.warning(`No active workflow found for token: ${decision.targetToken}`);
      return;
    }

    try {
      if (decision.shouldTrade) {
        // Step 3: Trade execution
        this.updateWorkflowState(workflowId, { tradeExecution: 'IN_PROGRESS' });

        if (this.isDryRun) {
          this.logger.info(`[DRY RUN] Would execute trade: ${decision.tradeAmountUsd} USD for ${decision.targetToken}`);
          
          // Emit mock result for dry run
          this.eventManager.emit('tradeResult', {
            success: true,
            signature: 'DRY_RUN_SIGNATURE',
            tradeId: 'DRY_RUN_TRADE',
            positionId: 'DRY_RUN_POSITION',
            timestamp: Date.now(),
          });
        } else {
          const result = await this.tradeExecutor.executeTrade(decision);
          this.eventManager.emit('tradeResult', result);
        }
      } else {
        this.logger.info(`Trade decision: SKIP - ${decision.reason}`);
        this.updateWorkflowState(workflowId, { tradeExecution: 'SKIPPED' });
        this.cleanupWorkflow(workflowId);
      }

    } catch (error) {
      this.logger.error(`Trade execution workflow failed: ${(error as Error).message}`);
      this.updateWorkflowState(workflowId, { tradeExecution: 'FAILED' });
      
      // Emit failed result
      this.eventManager.emit('tradeResult', {
        success: false,
        error: (error as Error).message,
        timestamp: Date.now(),
      });
    }
  }

  private async handleTradeResultWorkflow(result: TradeResult): Promise<void> {
    const workflowId = this.findWorkflowByTradeId(result.tradeId);
    
    if (!workflowId) {
      this.logger.debug('Trade result received but no active workflow found');
      return;
    }

    try {
      if (result.success) {
        this.logger.info(`Trading workflow completed successfully: ${result.signature}`);
        this.updateWorkflowState(workflowId, { tradeExecution: 'COMPLETED' });
        
        if (result.positionId) {
          this.logger.info(`Position created: ${result.positionId}`);
        }
      } else {
        this.logger.error(`Trading workflow failed: ${result.error}`);
        this.updateWorkflowState(workflowId, { tradeExecution: 'FAILED' });
      }

      // Cleanup completed workflow
      this.cleanupWorkflow(workflowId);

    } catch (error) {
      this.logger.error(`Error handling trade result: ${(error as Error).message}`);
      this.cleanupWorkflow(workflowId);
    }
  }

  private updateWorkflowState(workflowId: string, updates: Partial<TradingWorkflowState>): void {
    const currentState = this.activeWorkflows.get(workflowId);
    if (currentState) {
      this.activeWorkflows.set(workflowId, { ...currentState, ...updates });
      this.logger.debug(`Workflow ${workflowId} state updated:`, updates);
    }
  }

  private findWorkflowByToken(tokenAddress: string): string | null {
    // This is a simplified implementation - in practice, you'd maintain 
    // a more sophisticated mapping between tokens and workflow IDs
    for (const [workflowId] of this.activeWorkflows) {
      if (workflowId.includes('pool_')) {
        return workflowId; // Return first matching workflow
      }
    }
    return null;
  }

  private findWorkflowByTradeId(tradeId?: string): string | null {
    if (!tradeId || tradeId === 'DRY_RUN_TRADE') {
      // For dry run or missing trade ID, return the first active workflow
      return this.activeWorkflows.keys().next().value || null;
    }
    
    // In a real implementation, you'd have a proper mapping
    return this.activeWorkflows.keys().next().value || null;
  }

  private cleanupWorkflow(workflowId: string): void {
    this.activeWorkflows.delete(workflowId);
    const stateMachine = this.activeStateMachines.get(workflowId);
    if (stateMachine) {
      stateMachine.reset();
      this.activeStateMachines.delete(workflowId);
    }
    this.logger.debug(`Cleaned up workflow: ${workflowId}`);
  }

  public getActiveWorkflows(): Map<string, TradingWorkflowState> {
    return new Map(this.activeWorkflows);
  }

  public getWorkflowState(workflowId: string): TradingWorkflowState | null {
    return this.activeWorkflows.get(workflowId) || null;
  }

  public getStateMachine(workflowId: string): TradingStateMachine | null {
    return this.activeStateMachines.get(workflowId) || null;
  }

  public getActiveStateMachines(): Map<string, TradingStateMachine> {
    return new Map(this.activeStateMachines);
  }
}