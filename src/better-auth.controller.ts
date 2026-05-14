import { All, Controller, Inject, Injectable, Req } from '@velajs/vela';
import type { Context } from 'hono';
import { BetterAuthService } from './better-auth.service';
import { Public } from './decorators/public.decorator';

@Public(true)
@Controller('/api/auth')
@Injectable()
export class BetterAuthCatchallController {
  // Inject the service — its `.handler` getter triggers lazy construction
  // of the underlying betterAuth() instance on first access, AFTER any
  // runtime adapter middleware (Cloudflare env capture) has run.
  constructor(@Inject(BetterAuthService) private readonly auth: BetterAuthService) {}

  @All('/*')
  async handle(@Req() c: Context): Promise<Response> {
    return this.auth.handler(c.req.raw);
  }
}
