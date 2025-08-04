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
  status: 'STARTING' | 'READY' | 'PAUSED' | 'ERROR' | 'SHUTDOWN';
  reason?: string;
  timestamp: number;
  details?: Record<string, any>;
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
  level: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  timestamp: number;
  data?: Record<string, any>;
  channels?: ('console' | 'telegram' | 'discord' | 'email')[];
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
