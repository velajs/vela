import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  Scope,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '../index.js';
import {
  TRUSTED_REQUEST_IDENTITY,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  type TrustedRequestIdentity,
} from '../module-kit';
import { RATE_LIMIT, ThrottlerModule, type RateLimitInfo } from '../throttler/index';

@Injectable()
class SignInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.getRequest();
    if (request.headers.get('x-user') === null) return true;
    setTrustedRequestIdentity(request, {
      principal: {
        issuer: 'tests',
        subject: request.headers.get('x-user')!,
        principalType: 'user',
      },
    });
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class Whoami {
  constructor(@Inject(REQUEST_CONTEXT) private readonly context: RequestContext) {}

  describe(): { subject?: string; same: boolean; present: boolean; writeRejected: boolean } {
    const identity: TrustedRequestIdentity | undefined = this.context.get(TRUSTED_REQUEST_IDENTITY);
    let writeRejected = false;
    try {
      this.context.set(TRUSTED_REQUEST_IDENTITY, {
        principal: { issuer: 'forged', subject: 'root', principalType: 'service' },
      });
    } catch (error) {
      writeRejected = error instanceof TypeError;
    }
    return {
      ...(identity === undefined ? {} : { subject: identity.principal.subject }),
      same: identity === getTrustedRequestIdentity(this.context.request),
      present: this.context.has(TRUSTED_REQUEST_IDENTITY),
      writeRejected,
    };
  }
}

@Controller('/whoami')
@UseGuards(SignInGuard)
class WhoamiController {
  constructor(@Inject(Whoami) private readonly whoami: Whoami) {}

  @Get()
  get() {
    return this.whoami.describe();
  }
}

describe('trusted request context keys', () => {
  it('reads the trusted identity through REQUEST_CONTEXT and rejects writes', async () => {
    @Module({ controllers: [WhoamiController], providers: [SignInGuard, Whoami] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();
    expect(await (await hono.request('/whoami', { headers: { 'x-user': 'ada' } })).json()).toEqual({
      subject: 'ada',
      same: true,
      present: true,
      writeRejected: true,
    });
    expect(await (await hono.request('/whoami')).json()).toEqual({
      same: true,
      present: false,
      writeRejected: true,
    });
  });

  it('publishes throttling state under RATE_LIMIT', async () => {
    @Controller('/limited')
    class LimitedController {
      constructor(@Inject(REQUEST_CONTEXT) private readonly context: RequestContext) {}

      @Get()
      get(): Readonly<Record<string, RateLimitInfo>> | undefined {
        return this.context.get(RATE_LIMIT);
      }
    }

    @Module({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ limit: 5, ttl: 60_000 }] })],
      controllers: [LimitedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/limited');
    expect(await response.json()).toEqual({ default: { limit: 5, remaining: 4, reset: 60 } });
  });
});
