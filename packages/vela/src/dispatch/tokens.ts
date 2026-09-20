import { InjectionToken } from '../container/types';
import type { InvocationTransport, NonceStore } from './types';

/**
 * Header carrying the signed invocation token on an internal re-entry request.
 * Read by {@link SignedInvocationGuard}, written by {@link InternalDispatcher}.
 */
export const INVOCATION_HEADER = 'x-vela-invocation';

/**
 * The effective {@link InvocationTransport}, registered by `VelaFactory` after
 * the Hono app is built (adapter-provided override, else the in-isolate
 * `app.fetch` short-circuit). {@link InternalDispatcher} resolves it lazily at
 * `run()` time — so it need not exist when the dispatcher is constructed.
 */
export const INVOCATION_TRANSPORT = new InjectionToken<InvocationTransport>('INVOCATION_TRANSPORT');

/**
 * Optional dedicated HMAC secret for invocation tokens. Falls back to
 * {@link URL_SIGNING_SECRET} so one secret configures both `@SignedUrl` and
 * `@SignedInvocation`; the `aud` tag keeps the two token families
 * non-interchangeable. Provide it to enforce key separation.
 */
export const INVOCATION_SIGNING_SECRET = new InjectionToken<string>('INVOCATION_SIGNING_SECRET');

/** Overridable {@link NonceStore} token; defaults to `MemoryNonceStore`. */
export const NONCE_STORE = new InjectionToken<NonceStore>('NONCE_STORE');
