import { All, Controller, Inject, Req, type Type } from '@velajs/vela';
import { BetterAuthService } from './better-auth.service';
import { Public } from './decorators/public.decorator';
import { normalizeBetterAuthBasePath } from './base-path';

/**
 * Build a catch-all controller that mounts better-auth's handler at `basePath`
 * (default `/api/auth`). This is a factory because vela reads a controller's
 * route off the class at decoration time, so a custom base path needs its own
 * decorated class — the path can't be parametrized on a single shared class.
 *
 * Two base paths to keep consistent:
 * - this `basePath` is RELATIVE to vela's `globalPrefix` (always prepended);
 * - better-auth routes against its OWN absolute `basePath` (the one you pass to
 *   `betterAuth({ basePath })`), which must equal `globalPrefix + basePath`.
 *
 * Both default to `/api/auth`, so the no-prefix / no-config case just works.
 */
export function createBetterAuthCatchallController(basePath: string = '/api/auth'): Type {
  const normalizedBasePath = normalizeBetterAuthBasePath(basePath);
  @Public(true)
  @Controller(normalizedBasePath)
  class BetterAuthCatchallController {
    // Inject the service — its `.handler` getter triggers lazy construction
    // of the underlying betterAuth() instance on first access, AFTER any
    // runtime adapter middleware (Cloudflare env capture) has run.
    constructor(@Inject(BetterAuthService) private readonly auth: BetterAuthService) {}

    @All('/*')
    async handle(@Req() request: Request): Promise<Response> {
      return this.auth.handler(request);
    }
  }
  return BetterAuthCatchallController;
}
