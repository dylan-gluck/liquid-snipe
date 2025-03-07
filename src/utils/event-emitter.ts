/**
 * @deprecated Use the EventManager from the events module instead.
 * This file is kept for backwards compatibility only.
 */

import { EventManager } from '../events/event-manager';
import { EventMap, EventName, EventHandler } from '../events/types';

/**
 * Legacy EventEmitter class that now just wraps the newer EventManager.
 * This is maintained for backwards compatibility.
 * 
 * @deprecated Use the EventManager from the events module instead.
 */
export class EventEmitter {
  private eventManager: EventManager;

  constructor() {
    // Create a new event manager
    this.eventManager = new EventManager();
    
    // Print a deprecation warning
    console.warn(`
      ⚠️ The EventEmitter class is deprecated and will be removed in a future version.
      Please use the EventManager from the events module instead.
    `);
  }

  public on<K extends EventName>(event: K, listener: EventHandler<K>): () => void {
    return this.eventManager.on(event, listener);
  }

  public once<K extends EventName>(event: K, listener: EventHandler<K>): void {
    this.eventManager.once(event, listener);
  }

  public off<K extends EventName>(event: K, listener: EventHandler<K>): void {
    this.eventManager.off(event, listener);
  }

  public emit<K extends EventName>(event: K, data: EventMap[K]): boolean {
    return this.eventManager.emit(event, data);
  }

  public removeAllListeners(event?: EventName): void {
    this.eventManager.removeAllListeners(event);
  }
}

// Export the main EventManager as the default instance
import { eventManager } from '../events/event-manager';
export const eventEmitter = eventManager;
export default eventEmitter;