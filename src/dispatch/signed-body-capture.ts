// Bridges the args-before-guards gap for `@SignedInvocation()` routes.
//
// vela's HTTP pipeline resolves handler arguments BEFORE guards (a deliberate
// NestJS-parity contract — see PipelineRunner). So on a signed route whose
// handler declares `@Body()`, the body is consumed (`c.req.json()` sets
// `bodyUsed = true`) before `SignedInvocationGuard` runs — and the guard's own
// `request.clone().arrayBuffer()` then throws because a used body can't be
// cloned. The signature covers a `bodyHash`, so the guard MUST see the raw
// bytes to verify it.
//
// This handler-scoped middleware runs BEFORE the route handler (Hono runs
// `app.use(path)` middleware ahead of the matched handler; RouteManager installs
// scoped middleware for the route ahead of registering it), i.e. while
// `bodyUsed === false`. It clones the request, hashes the clone's bytes (the
// original stream is left intact for `@Body()`), and publishes the hash to the
// guard through a module-private WeakMap keyed by the SAME `Request` object the
// guard reads (`c.req.raw`). Composed onto routes by `SignedInvocation()`; it is
// never a public export.

import type { Context, Next } from 'hono';
import { Injectable } from '../container/decorators';
import { sha256Base64Url } from '../crypto/hmac';
import type { NestMiddleware } from '../pipeline/types';

// Published from the capture middleware, read once by the guard. WeakMap keying
// on the live `Request` needs no Hono context augmentation and no cast, evicts
// automatically with the request (GC-safe), and never mutates the request. An
// empty body maps to `''`, matching the empty `bodyHash` a bodyless claim signs.
const capturedBodyHashes = new WeakMap<Request, string>();

/** Read (and consume) the hash captured for `request`; `undefined` if none. */
export function takeCapturedBodyHash(request: Request): string | undefined {
  const hash = capturedBodyHashes.get(request);
  if (hash !== undefined) capturedBodyHashes.delete(request);
  return hash;
}

/**
 * Hashes the raw request body before `@Body()` (or any other consumer) reads it,
 * and stashes the digest for {@link SignedInvocationGuard}. Zero constructor
 * dependencies, so `instantiate()` news it up directly per request.
 */
@Injectable()
export class SignedInvocationBodyCapture implements NestMiddleware {
  async use(c: Context, next: Next): Promise<void> {
    const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const hash = bytes.byteLength === 0 ? '' : await sha256Base64Url(bytes);
    capturedBodyHashes.set(c.req.raw, hash);
    await next();
  }
}
