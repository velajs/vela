import IntlMessageFormat from 'intl-messageformat';
import { Inject, Injectable } from '../container/decorators';
import type { I18nModuleOptions } from './i18n.options';
import { I18N_OPTIONS } from './i18n.tokens';
import { MessageRegistry } from './message-registry';

type CompiledMessages = Record<string, (params?: Record<string, unknown>) => string>;

/**
 * Compiles and caches ICU messages (via `intl-messageformat`). Singleton: reads
 * the merged registry once at construction (all `registerMessages` calls run at
 * module-load, before providers are instantiated), flattens each locale to
 * dot-paths, and compiles lazily per locale.
 */
@Injectable()
export class MessageLoaderService {
  private readonly cache = new Map<string, Record<string, unknown>>();
  private readonly compiledCache = new Map<string, CompiledMessages>();
  private readonly defaultLocale: string;
  private readonly fallbackLocale: string;

  constructor(
    @Inject(MessageRegistry) registry: MessageRegistry,
    @Inject(I18N_OPTIONS) options: I18nModuleOptions,
  ) {
    this.defaultLocale = options?.defaultLocale ?? 'en';
    this.fallbackLocale = options?.fallbackLocale ?? this.defaultLocale;
    const merged = registry.getMergedMessages();
    for (const locale of Object.keys(merged)) {
      this.cache.set(locale, merged[locale]!);
    }
  }

  translate(locale: string, key: string, params?: Record<string, unknown>): string {
    const primary = this.getCompiledMessages(locale)[key];
    if (primary) return primary(params);
    // Per-key fallback: a supported locale missing an individual key falls back
    // to fallbackLocale before giving up (returning the raw key).
    if (this.fallbackLocale !== locale) {
      const fallback = this.getCompiledMessages(this.fallbackLocale)[key];
      if (fallback) return fallback(params);
    }
    return key; // missing everywhere → return the key (dev-friendly)
  }

  getAvailableLocales(): string[] {
    return [...this.cache.keys()];
  }

  isLocaleSupported(locale: string): boolean {
    return this.cache.has(locale);
  }

  getDefaultLocale(): string {
    return this.defaultLocale;
  }

  private getCompiledMessages(locale: string): CompiledMessages {
    const effectiveLocale = this.cache.has(locale) ? locale : this.defaultLocale;
    const cached = this.compiledCache.get(effectiveLocale);
    if (cached) return cached;

    const flattened = this.flattenMessages(this.cache.get(effectiveLocale) ?? {});
    const compiled: CompiledMessages = {};
    for (const [key, value] of Object.entries(flattened)) {
      const msg = new IntlMessageFormat(value, effectiveLocale);
      compiled[key] = (params) =>
        String(msg.format(params as Record<string, string | number | boolean>));
    }
    this.compiledCache.set(effectiveLocale, compiled);
    return compiled;
  }

  private flattenMessages(messages: Record<string, unknown>, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(messages)) {
      const value = messages[key];
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, this.flattenMessages(value as Record<string, unknown>, newKey));
      } else {
        result[newKey] = String(value);
      }
    }
    return result;
  }
}
