import type { Context, Next } from 'hono';
import { findRequestContainer } from '../http/request-container';
import { Inject, Injectable } from '../container/decorators';
import { REQUEST_CONTEXT } from '../http/request-context';
import type { NestMiddleware } from '../pipeline/types';
import {
  resolveI18nOptions,
  type I18nModuleOptions,
  type ResolvedI18nOptions,
} from './i18n.options';
import { I18N_LOCALE_KEY, I18N_OPTIONS } from './i18n.tokens';

/**
 * Detects the request locale and stashes it on the per-request RequestContext
 * bag under {@link I18N_LOCALE_KEY}, where {@link I18nService} reads it.
 * Registered globally via APP_MIDDLEWARE by {@link I18nModule}. Holds no
 * per-request state (reads the RequestContext off the request container each
 * call), so a singleton instance is safe.
 */
@Injectable()
export class I18nLocaleMiddleware implements NestMiddleware {
  private readonly resolved: ResolvedI18nOptions;

  constructor(@Inject(I18N_OPTIONS) options: I18nModuleOptions) {
    this.resolved = resolveI18nOptions(options);
  }

  async use(c: Context, next: Next): Promise<Response | void> {
    const container = findRequestContainer(c);
    if (container) {
      const ctx = container.resolve(REQUEST_CONTEXT);
      ctx.set(I18N_LOCALE_KEY, detectLocale(c, this.resolved));
    }
    return next();
  }
}

function detectLocale(c: Context, resolved: ResolvedI18nOptions): string {
  if (!resolved.detection.enabled) return resolved.defaultLocale;

  const { strategy, lookupKey } = resolved.detection;
  // Candidate tags in preference order.
  const candidates: string[] =
    strategy === 'query'
      ? [new URL(c.req.url).searchParams.get(lookupKey) ?? '']
      : strategy === 'cookie'
        ? [readCookie(c.req.raw.headers.get('cookie'), lookupKey) ?? '']
        : parseAcceptLanguage(c.req.raw.headers.get('accept-language'));

  for (const candidate of candidates) {
    const match = matchLocale(candidate, resolved.locales);
    if (match) return match;
  }
  return resolved.defaultLocale;
}

/** Case-insensitive locale match with region fallback (en-US -> en); returns the configured casing. */
function matchLocale(candidate: string, locales: string[]): string | undefined {
  if (!candidate) return undefined;
  const lc = candidate.toLowerCase();
  const exact = locales.find((l) => l.toLowerCase() === lc);
  if (exact) return exact;
  const base = lc.split('-')[0];
  return locales.find((l) => l.toLowerCase().split('-')[0] === base);
}

/** Parse Accept-Language into tags ordered by descending q-value (RFC 7231). */
function parseAcceptLanguage(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = p.trim().match(/^q=([\d.]+)$/);
        if (m) q = Number.parseFloat(m[1]!);
      }
      return { tag: (tag ?? '').trim(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((e) => e.tag && e.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((e) => e.tag);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    if (rawKey?.trim() === name) {
      const raw = rest.join('=').trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoding must not crash locale detection.
        return raw;
      }
    }
  }
  return undefined;
}
