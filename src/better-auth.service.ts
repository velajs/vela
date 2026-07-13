import { Inject, Injectable, InjectionToken } from '@velajs/vela';
import type { BetterAuthInstance } from './better-auth.types';

/**
 * Internal token holding the auth-construction closure with its inject deps
 * closed over. Resolves cheaply at module load (just captures references);
 * the inner call happens lazily on first auth use (see `BetterAuthService`).
 *
 * Not exported from the public surface — only the service consumes it.
 */
export const BETTER_AUTH_BUILDER = new InjectionToken<() => BetterAuthInstance>(
  'vela.better-auth.Builder',
);

/**
 * The single injectable consumers reach for to interact with better-auth.
 * Wraps the underlying `betterAuth({...})` instance with lazy construction:
 *
 * - `forRoot({ auth })` — the builder returns the eagerly-provided instance,
 *   so the first `.auth` / `.api` / `.handler` access is effectively a
 *   read-and-cache.
 * - `forRootAsync({ inject, useFactory })` — the builder wraps the user's
 *   factory + inject deps. First access triggers `useFactory(...deps)`. This
 *   is what makes Cloudflare D1/KV bindings work: at module load the factory
 *   doesn't run; on first request (when AuthGuard or the catch-all calls
 *   `service.api` / `service.handler`), the bindings are populated and the
 *   factory can read them safely.
 *
 * Used directly by AuthGuard and the catch-all controller. Consumers in
 * application code inject the same way: `@Inject(BetterAuthService)`.
 */
@Injectable()
export class BetterAuthService {
  private cached: BetterAuthInstance | undefined;

  constructor(@Inject(BETTER_AUTH_BUILDER) private readonly build: () => BetterAuthInstance) {}

  /**
   * The underlying better-auth instance. Constructed once on first access.
   * Safe to call from any request-time code path (guards, controllers,
   * services invoked from handlers).
   */
  get auth(): BetterAuthInstance {
    if (!this.cached) this.cached = this.build();
    return this.cached;
  }

  /** Convenience accessor — equivalent to `service.auth.api`. */
  get api(): BetterAuthInstance['api'] {
    return this.auth.api;
  }

  /** Convenience accessor — equivalent to `service.auth.handler`. */
  get handler(): BetterAuthInstance['handler'] {
    return this.auth.handler;
  }
}
