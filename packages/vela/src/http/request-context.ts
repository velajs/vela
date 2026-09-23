import type { VelaContext as Context } from './hono.types';
import { InjectionToken } from '../container/types';

// Per-request injectable populated by RouteManager. Carries a stable
// request id, the raw Request, the Hono Context (escape hatch), and a
// typed keys for cross-cutting metadata (locale, feature flags, trace ids, …).
// Raw string/symbol keys are available when the value is intentionally unknown. No
// AsyncLocalStorage — request scope is carried by the per-request child
// container.
export interface RequestContext {
  readonly id: string;
  readonly receivedAt: Date;
  readonly request: Request;
  readonly hono: Context;
  set<Value>(key: RequestContextKey<Value>, value: NoInfer<Value>): void;
  set(key: string | symbol, value: unknown): void;
  get<Value>(key: RequestContextKey<Value>): Value | undefined;
  get(key: string | symbol): unknown;
  has<Value>(key: RequestContextKey<Value> | string | symbol): boolean;
}

/**
 * An identity-based key for a request-local value. Reusing a description does
 * not alias another key. Each key owns its typed storage, so retrieval never
 * needs to reinterpret an unknown value from a heterogeneous map.
 */
export class RequestContextKey<Value> {
  readonly #values = new WeakMap<RequestContext, Value>();

  constructor(readonly description: string) {}

  /** @internal Read by RequestContext.get(). */
  readonly read = (context: RequestContext): Value | undefined => this.#values.get(context);

  /** @internal Write by RequestContext.set(). A function property keeps Value invariant. */
  readonly write = (context: RequestContext, value: Value): void => {
    this.#values.set(context, value);
  };

  /** @internal Read by RequestContext.has(). */
  readonly contains = (context: RequestContext): boolean => this.#values.has(context);
}

export const REQUEST_CONTEXT = new InjectionToken<RequestContext>('vela.RequestContext');

// An inbound id is caller-controlled and flows into logs and correlation
// fields, so only a bounded token-safe value is mirrored; anything else is
// replaced by a generated id.
const INBOUND_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestContext(c: Context): RequestContext {
  const bag = new Map<string | symbol, unknown>();
  const inboundId = c.req.raw.headers.get('x-request-id');
  const id =
    inboundId !== null && INBOUND_REQUEST_ID.test(inboundId) ? inboundId : crypto.randomUUID();

  function set<Value>(key: RequestContextKey<Value>, value: NoInfer<Value>): void;
  function set(key: string | symbol, value: unknown): void;
  function set<Value>(key: RequestContextKey<Value> | string | symbol, value: Value): void {
    if (key instanceof RequestContextKey) key.write(context, value);
    else bag.set(key, value);
  }

  function get<Value>(key: RequestContextKey<Value>): Value | undefined;
  function get(key: string | symbol): unknown;
  function get<Value>(key: RequestContextKey<Value> | string | symbol): unknown {
    return key instanceof RequestContextKey ? key.read(context) : bag.get(key);
  }

  const context: RequestContext = {
    id,
    receivedAt: new Date(),
    request: c.req.raw,
    hono: c,
    set,
    get,
    has(key) {
      return key instanceof RequestContextKey ? key.contains(context) : bag.has(key);
    },
  };
  return context;
}
