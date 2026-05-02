import type { Context } from 'hono';
import { InjectionToken } from '../container/types';

// Per-request injectable populated by RouteManager. Carries a stable
// request id, the raw Request, the Hono Context (escape hatch), and a
// free-form bag for cross-cutting metadata that doesn't merit its own
// injection token (locale, feature flags, trace ids, …). No
// AsyncLocalStorage — request scope is carried by the per-request child
// container.
export interface RequestContext {
  readonly id: string;
  readonly receivedAt: Date;
  readonly request: Request;
  readonly hono: Context;
  set<T>(key: string | symbol, value: T): void;
  get<T>(key: string | symbol): T | undefined;
  has(key: string | symbol): boolean;
}

export const REQUEST_CONTEXT = new InjectionToken<RequestContext>('vela.RequestContext');

export function createRequestContext(c: Context): RequestContext {
  const bag = new Map<string | symbol, unknown>();
  const inboundId = c.req.raw.headers.get('x-request-id');
  const id = inboundId && inboundId.length > 0 ? inboundId : crypto.randomUUID();
  return {
    id,
    receivedAt: new Date(),
    request: c.req.raw,
    hono: c,
    set(key, value) {
      bag.set(key, value);
    },
    get<T>(key: string | symbol): T | undefined {
      return bag.get(key) as T | undefined;
    },
    has(key) {
      return bag.has(key);
    },
  };
}
