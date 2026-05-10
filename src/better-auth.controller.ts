import { All, Controller, Inject, Injectable, Req } from '@velajs/vela';
import type { Context } from 'hono';
import { BETTER_AUTH } from './better-auth.tokens';
import type { BetterAuthInstance } from './better-auth.types';
import { Public } from './decorators/public.decorator';

@Public(true)
@Controller('/api/auth')
@Injectable()
export class BetterAuthCatchallController {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  @All('/*')
  async handle(@Req() c: Context): Promise<Response> {
    return this.auth.handler(c.req.raw);
  }
}
