import { EventEmitter as NodeEventEmitter } from 'events';
import { LogEvent, NewPoolEvent, TradeDecision, TradeResult } from '../types';

// Define the event map to ensure type safety
interface EventMap {
  newPool: NewPoolEvent;
  tradeDecision: TradeDecision;
  tradeResult: TradeResult;
  log: LogEvent;
}

export class EventEmitter {
  private emitter: NodeEventEmitter;

  constructor() {
    this.emitter = new NodeEventEmitter();
    // Set a higher limit for listeners
    this.emitter.setMaxListeners(30);
  }

  public on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  public once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.once(event, listener);
  }

  public off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  public emit<K extends keyof EventMap>(event: K, data: EventMap[K]): boolean {
    return this.emitter.emit(event, data);
  }

  public removeAllListeners<K extends keyof EventMap>(event?: K): void {
    this.emitter.removeAllListeners(event);
  }
}

// Export a singleton instance for common use
export const eventEmitter = new EventEmitter();
export default eventEmitter;