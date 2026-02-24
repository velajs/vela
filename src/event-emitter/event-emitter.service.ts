import { Injectable } from '../container/index';
import type { EventHandler } from './event-emitter.types';

@Injectable()
export class EventEmitter {
  private listeners = new Map<string, EventHandler[]>();
  private onceListeners = new Set<EventHandler>();

  on(event: string, handler: EventHandler): this {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.onceListeners.add(handler);
    return this.on(event, handler);
  }

  off(event: string, handler: EventHandler): this {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
      if (handlers.length === 0) this.listeners.delete(event);
    }
    this.onceListeners.delete(handler);
    return this;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    const handlers = this.getMatchingHandlers(event);
    const toRemove: { event: string; handler: EventHandler }[] = [];

    await Promise.all(
      handlers.map(async ({ event: registeredEvent, handler }) => {
        await handler(...args);
        if (this.onceListeners.has(handler)) {
          toRemove.push({ event: registeredEvent, handler });
        }
      }),
    );

    for (const { event: registeredEvent, handler } of toRemove) {
      this.off(registeredEvent, handler);
    }
  }

  removeAllListeners(event?: string): this {
    if (event) {
      const handlers = this.listeners.get(event);
      if (handlers) {
        for (const h of handlers) this.onceListeners.delete(h);
      }
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
    return this;
  }

  listenerCount(event: string): number {
    return this.getMatchingHandlers(event).length;
  }

  private getMatchingHandlers(event: string): { event: string; handler: EventHandler }[] {
    const result: { event: string; handler: EventHandler }[] = [];

    for (const [pattern, handlers] of this.listeners) {
      if (this.matchPattern(pattern, event)) {
        for (const handler of handlers) {
          result.push({ event: pattern, handler });
        }
      }
    }

    return result;
  }

  private matchPattern(pattern: string, event: string): boolean {
    if (pattern === event) return true;

    // Convert glob pattern to regex
    // ** matches any depth (any number of segments)
    // * matches single segment (no dots)
    const regexStr = pattern
      .split('.')
      .map((segment) => {
        if (segment === '**') return '.*';
        if (segment === '*') return '[^.]+';
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('\\.');

    return new RegExp(`^${regexStr}$`).test(event);
  }
}
