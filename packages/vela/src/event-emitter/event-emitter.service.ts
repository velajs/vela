import { Injectable } from '../container/index';
import type { EventHandler } from './event-emitter.types';

function isWildcard(pattern: string): boolean {
  return pattern.includes('*');
}

function compilePattern(pattern: string): RegExp {
  const regexStr = pattern
    .split('.')
    .map((segment) => {
      if (segment === '**') return '.*';
      if (segment === '*') return '[^.]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${regexStr}$`);
}

interface WildcardEntry {
  regex: RegExp;
  handlers: Set<EventHandler>;
  onceHandlers: Set<EventHandler>;
}

@Injectable()
export class EventEmitter {
  private exactListeners = new Map<string, Set<EventHandler>>();
  private exactOnceListeners = new Map<string, Set<EventHandler>>();
  private wildcardListeners = new Map<string, WildcardEntry>();

  on(event: string, handler: EventHandler): this {
    if (isWildcard(event)) {
      this.getOrCreateWildcard(event).handlers.add(handler);
    } else {
      const handlers = this.exactListeners.get(event) ?? new Set();
      handlers.add(handler);
      this.exactListeners.set(event, handlers);
    }
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.on(event, handler);
    if (isWildcard(event)) {
      this.getOrCreateWildcard(event).onceHandlers.add(handler);
    } else {
      const onceSet = this.exactOnceListeners.get(event) ?? new Set();
      onceSet.add(handler);
      this.exactOnceListeners.set(event, onceSet);
    }
    return this;
  }

  off(event: string, handler: EventHandler): this {
    if (isWildcard(event)) {
      const entry = this.wildcardListeners.get(event);
      if (entry) {
        entry.handlers.delete(handler);
        entry.onceHandlers.delete(handler);
        if (entry.handlers.size === 0) this.wildcardListeners.delete(event);
      }
    } else {
      const handlers = this.exactListeners.get(event);
      if (handlers) {
        handlers.delete(handler);
        this.exactOnceListeners.get(event)?.delete(handler);
        if (handlers.size === 0) this.exactListeners.delete(event);
      }
    }
    return this;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    const toRemove: Array<() => void> = [];

    // Exact match
    const exactHandlers = this.exactListeners.get(event);
    if (exactHandlers) {
      const onceSet = this.exactOnceListeners.get(event);
      await Promise.all(
        [...exactHandlers].map(async (handler) => {
          await handler(...args);
          if (onceSet?.has(handler)) {
            toRemove.push(() => this.off(event, handler));
          }
        }),
      );
    }

    // Wildcard match (regex pre-compiled at registration)
    for (const [pattern, entry] of this.wildcardListeners) {
      if (!entry.regex.test(event)) continue;
      await Promise.all(
        [...entry.handlers].map(async (handler) => {
          await handler(...args);
          if (entry.onceHandlers.has(handler)) {
            toRemove.push(() => this.off(pattern, handler));
          }
        }),
      );
    }

    for (const remove of toRemove) remove();
  }

  removeAllListeners(event?: string): this {
    if (event) {
      if (isWildcard(event)) {
        this.wildcardListeners.delete(event);
      } else {
        this.exactListeners.delete(event);
        this.exactOnceListeners.delete(event);
      }
    } else {
      this.exactListeners.clear();
      this.exactOnceListeners.clear();
      this.wildcardListeners.clear();
    }
    return this;
  }

  listenerCount(event: string): number {
    let count = this.exactListeners.get(event)?.size ?? 0;
    for (const entry of this.wildcardListeners.values()) {
      if (entry.regex.test(event)) count += entry.handlers.size;
    }
    return count;
  }

  private getOrCreateWildcard(pattern: string): WildcardEntry {
    const existing = this.wildcardListeners.get(pattern);
    if (existing) return existing;
    const entry: WildcardEntry = {
      regex: compilePattern(pattern),
      handlers: new Set(),
      onceHandlers: new Set(),
    };
    this.wildcardListeners.set(pattern, entry);
    return entry;
  }
}
