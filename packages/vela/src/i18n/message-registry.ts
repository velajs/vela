import { Injectable } from '../container/decorators';
import { deepMerge } from './deep-merge';

// Shared contributions store anchored on globalThis so bundler-inlined copies
// (portal/symlink) and Vite HMR re-eval share ONE store. Content-keyed so
// re-registering identical messages (HMR) dedups instead of accumulating.
const CONTRIBUTIONS_KEY = Symbol.for('vela:i18n:message-registry:contributions');

type Contribution = Record<string, Record<string, unknown>>;
type Contributions = Map<string, Contribution>;

function getContributions(): Contributions {
  const g = globalThis as unknown as Record<symbol, Contributions | undefined>;
  return (g[CONTRIBUTIONS_KEY] ??= new Map());
}

function contentKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contentKey).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${contentKey((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Accumulates i18n messages from multiple `I18nModule.registerMessages()` calls
 * (statically, at module import time), deep-merged on read by
 * {@link MessageLoaderService}. Later registrations override earlier ones at the
 * leaf level.
 */
@Injectable()
export class MessageRegistry {
  /** Called by `I18nModule.registerMessages()`. */
  static addMessages(messages: Contribution): void {
    if (messages && typeof messages === 'object' && Object.keys(messages).length > 0) {
      // set() dedups by content-key AND preserves insertion order for an existing
      // key. (A prior delete+set moved re-registered content to the end, flipping
      // deep-merge precedence under HMR re-eval.)
      getContributions().set(contentKey(messages), messages);
    }
  }

  /** All contributions deep-merged, per locale, in registration order. */
  getMergedMessages(): Record<string, Record<string, unknown>> {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const contribution of getContributions().values()) {
      for (const locale of Object.keys(contribution)) {
        merged[locale] = deepMerge(merged[locale] ?? {}, contribution[locale]!);
      }
    }
    return merged;
  }

  /** @internal — testing */
  static reset(): void {
    (globalThis as unknown as Record<symbol, Contributions>)[CONTRIBUTIONS_KEY] = new Map();
  }
}
