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
 * - `auth` is an instance — the builder returns it, so the first `.auth` /
 *   `.api` / `.handler` access is effectively a read-and-cache.
 * - `auth` is a function (`auth: () => betterAuth({ ... })`, typically
 *   returned by a `forRootAsync` factory) — the first access calls it. On
 *   Workers, construction then happens on the first request (when AuthGuard
 *   or the catch-all calls `service.api` / `service.handler`), never at
 *   bootstrap.
 *
 * Used directly by AuthGuard and the catch-all controller. Consumers in
 * application code inject the same way: `@Inject(BetterAuthService)`.
 */
@Injectable()
export class BetterAuthService<TAuth extends BetterAuthInstance = BetterAuthInstance> {
  #cached: TAuth | undefined;

  readonly #build: () => TAuth;

  constructor(@Inject(BETTER_AUTH_BUILDER) build: () => TAuth) {
    this.#build = build;
  }

  /**
   * The underlying better-auth instance. Constructed once on first access.
   * Safe to call from any request-time code path (guards, controllers,
   * services invoked from handlers).
   */
  get auth(): TAuth {
    if (!this.#cached) this.#cached = this.#build();
    return this.#cached;
  }

  /** Convenience accessor — equivalent to `service.auth.api`. */
  get api(): TAuth['api'] {
    return this.auth.api;
  }

  /** Convenience accessor — equivalent to `service.auth.handler`. */
  get handler(): TAuth['handler'] {
    return this.auth.handler;
  }
}
