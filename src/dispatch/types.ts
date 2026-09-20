import type { RouteName, RouteParams } from '../http/route-map';

/**
 * How a signed invocation is actually delivered. The DEFAULT (registered by
 * `VelaFactory` once the Hono app is built) is the in-isolate short-circuit
 * `(req) => app.fetch(req)` — it skips the NETWORK hop but STILL runs the full
 * request pipeline, so `@SignedInvocation()` always verifies. A separate-binding
 * adapter (a Cloudflare Workflow entrypoint calling back over a service binding)
 * returns an HTTP transport instead. One code path serves both cases.
 */
export type InvocationTransport = (request: Request) => Promise<Response>;

/** A named route + its params — the type-safe target. */
export interface InvocationRouteTarget<N extends RouteName = RouteName> {
  route: N;
  params?: RouteParams<N>;
}

/** A pre-composed path (`pathname?search`) — the escape hatch. */
export interface InvocationPathTarget {
  path: string;
}

/** Where an invocation is directed: a named route or a raw path. */
export type InvocationTarget = InvocationRouteTarget | InvocationPathTarget;

/** Per-call options for {@link InternalDispatcher.run}. */
export interface RunInit {
  /** HTTP method (default `POST`). Bound into the signature, upper-cased. */
  method?: string;
  /** JSON-serialized into the request body and hashed into the claim. */
  body?: unknown;
  /** Extra request headers (the invocation token header is always added). */
  headers?: HeadersInit;
  /** Claim lifetime override (default {@link INVOCATION_DEFAULT_TTL_SECONDS}). */
  ttlSeconds?: number;
  /** OPTIONAL observability label carried in the claim's `iss`; never authz. */
  iss?: string;
  /** Abort when the caller's signal fires, preserving its abort reason. */
  signal?: AbortSignal;
  /**
   * Abort the transport and response-body read after this many milliseconds.
   * Must be finite and greater than zero. Defaults to 30 seconds.
   */
  timeoutMs?: number;
}

/**
 * Single-use nonce reservation for invocation claims. `claim` returns `false`
 * when the nonce has already been seen (⇒ the guard rejects a replay).
 *
 * The default {@link MemoryNonceStore} enforces single-use only WITHIN one
 * isolate. Cross-isolate single-use needs a shared store (Durable Object / KV)
 * supplied by the adapter; without one, single-use degrades to
 * "replay-once-per-isolate within the (short) `exp` window". For workflow this
 * is defense-in-depth — `step.do` memoization is the primary idempotency layer.
 */
export interface NonceStore {
  claim(nonce: string, expEpochSeconds: number): Promise<boolean>;
}
