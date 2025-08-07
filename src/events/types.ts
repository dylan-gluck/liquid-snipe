/**
 * Event types for the Liquid-Snipe application
 * This file defines all event types and their payloads to ensure type safety
 * across the entire application.
 */

import {
  LogEvent,
  NewPoolEvent,
  TradeDecision,
  TradeResult,
  Position,
  Token,
  LiquidityPool,
} from '../types';

/**
 * PositionUpdateEvent is emitted when a position's status changes
 */
export interface PositionUpdateEvent {
  position: Position;
  previousStatus?: 'OPEN' | 'CLOSED';
  updateType: 'CREATED' | 'UPDATED' | 'CLOSED';
  reason?: string;
  timestamp: number;
}

/**
 * SystemStatusEvent is emitted when the system status changes
 */
export interface SystemStatusEvent {
  status: 'STARTING' | 'READY' | 'PAUSED' | 'ERROR' | 'SHUTDOWN' | 'CRITICAL_ERROR';
  reason?: string;
  timestamp: number;
  details?: Record<string, any>;
  data?: Record<string, any>;
}

/**
 * ConnectionStatusEvent is emitted when connection status changes
 */
export interface ConnectionStatusEvent {
  type: 'RPC' | 'WEBSOCKET' | 'DATABASE';
  status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'ERROR';
  endpoint?: string;
  latency?: number;
  timestamp: number;
  error?: string;
}

/**
 * TokenUpdateEvent is emitted when token information is updated
 */
export interface TokenUpdateEvent {
  token: Token;
  updateType: 'NEW' | 'UPDATED' | 'METADATA' | 'VERIFICATION';
  timestamp: number;
}

/**
 * LiquidityUpdateEvent is emitted when a pool's liquidity changes
 */
export interface LiquidityUpdateEvent {
  pool: LiquidityPool;
  previousLiquidity: number;
  currentLiquidity: number;
  changePercent: number;
  timestamp: number;
}

/**
 * WalletUpdateEvent is emitted when wallet information changes
 */
export interface WalletUpdateEvent {
  balanceChanges: Record<
    string,
    {
      token: string;
      symbol?: string;
      previousBalance: number;
      currentBalance: number;
      valueUsd?: number;
    }
  >;
  totalValueUsd?: number;
  reason?: string;
  timestamp: number;
}

/**
 * NotificationEvent is emitted when a notification should be sent
 */
export interface NotificationEvent {
  id: string;
  level: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  timestamp: number;
  urgent?: boolean;
  data?: Record<string, any>;
  channels?: ('console' | 'telegram' | 'discord' | 'email')[];
}

/**
 * ErrorEvent is emitted when an error occurs that needs handling
 */
export interface ErrorEventData {
  error: Error;
  context: string;
  category: {
    category: 'CONNECTION' | 'DATABASE' | 'TRADING' | 'SYSTEM' | 'USER_INPUT';
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    recoverable: boolean;
  };
  metadata?: Record<string, any>;
}

// Additional interfaces for workflow events
export interface ExitRequest {
  positionId: string;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  partialExitPercentage?: number;
}

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

/**
 * The complete EventMap that maps event names to their payload types.
 * This ensures full type safety throughout the event system.
 */
export interface EventMap {
  // Existing event types
  newPool: NewPoolEvent;
  tradeDecision: TradeDecision;
  tradeResult: TradeResult;
  log: LogEvent;

  // New event types
  positionUpdate: PositionUpdateEvent;
  systemStatus: SystemStatusEvent;
  connectionStatus: ConnectionStatusEvent;
  tokenUpdate: TokenUpdateEvent;
  liquidityUpdate: LiquidityUpdateEvent;
  walletUpdate: WalletUpdateEvent;
  notification: NotificationEvent;
  error: ErrorEventData;

  // Workflow event types
  systemControl: { action: string; timestamp: number; details?: any };
  configUpdate: { section?: string; config?: any; timestamp: number };
  backupCompleted: { backupPath: string; timestamp: number; size?: number; success?: boolean };
  backupFailed: { error: string; timestamp: number; details?: any };
  cleanupCompleted: { deletedItems?: number | { logs: number }; logs?: number; timestamp: number; details?: any; success?: boolean };
  cleanupFailed: { error: string; timestamp: number; details?: any };
  configUpdateCompleted: { updatedSections: string[]; timestamp: number; details?: any };
  recoverySuccess: { errorId: string; timestamp: number; context?: string; strategy?: string; attempts?: number; details?: any };
  recoveryFailed: { errorId: string; error: string; timestamp: number; context?: string; totalAttempts?: number; details?: any };
  emergencyShutdown: { reason: string; error?: string; timestamp: number };
  circuitBreakerTriggered: { category: string; reason?: string; timestamp: number };
  circuitBreakerReset: { category: string; timestamp: number };
  criticalError: { error?: string; errorId?: string; context: string; timestamp: number; details?: any };
  exitRequest: ExitRequest;
  userCommand: UserCommand;
  tuiCommand: UserCommand;
  commandResult: { success: boolean; result?: any; error?: string; timestamp: number };
  strategyChange: { strategy?: string; newStrategy?: any; positionId?: string; config?: any; timestamp?: number };
}

/**
 * Union type of all event names defined in the EventMap.
 * This makes it easy to work with event names as a type.
 */
export type EventName = keyof EventMap;

/**
 * Type for event handlers/listeners with proper typing based on the event name.
 */
export type EventHandler<T extends EventName> = (data: EventMap[T]) => void | Promise<void>;

/**
 * Interface for objects that can emit events
 */
export interface EventEmitter {
  emit<T extends EventName>(event: T, data: EventMap[T]): boolean;
}

/**
 * Interface for objects that can receive events
 */
export interface EventReceiver {
  on<T extends EventName>(event: T, handler: EventHandler<T>): () => void;
  once<T extends EventName>(event: T, handler: EventHandler<T>): void;
  off<T extends EventName>(event: T, handler: EventHandler<T>): void;
}

/**
 * Combined interface for objects that can both emit and receive events
 */
export interface EventProcessor extends EventEmitter, EventReceiver {
  removeAllListeners(event?: EventName): void;
}
