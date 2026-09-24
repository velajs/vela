import { defineProvider } from '../../container/types';
import type { Context } from 'hono';
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  Req,
  Scope,
  SignedUrl,
  URL_SIGNING_SECRET,
  UrlGeneratorService,
  VelaFactory,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type RequestContext,
} from '../../index';
import { ApiResponse, ApiTags, createOpenApiDocument } from '../../openapi/index';
import { getRequestContainer } from '../../module-kit';
import { I18nModule, I18nService } from '../../i18n';
import { signUrl, verifySignedUrl } from '../../security/index';
import type { VelaApplication } from '../../application';

// Smoke-test app for the workerd live-runtime suite. Each route exercises
// a different slice of the framework end-to-end.

const traces = new WeakMap<Request, string[]>();

function pushTrace(req: Request, label: string): void {
  const trace = traces.get(req) ?? [];
  trace.push(label);
  traces.set(req, trace);
}

@Injectable()
class TraceGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    pushTrace(ctx.switchToHttp().getRequest(), 'guard');
    return true;
  }
}

@Injectable()
class TracePipe implements PipeTransform {
  // Pipes don't get the request directly. Stash a global marker; the
  // interceptor reads + clears it. workerd is single-threaded so this
  // is safe per request.
  transform(value: unknown): unknown {
    (globalThis as { __velaPipeFired?: boolean }).__velaPipeFired = true;
    return value;
  }
}

@Injectable()
class TraceInterceptor implements NestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if ((globalThis as { __velaPipeFired?: boolean }).__velaPipeFired) {
      pushTrace(req, 'pipe');
      delete (globalThis as { __velaPipeFired?: boolean }).__velaPipeFired;
    }
    pushTrace(req, 'interceptor');
    const result = await next.handle();
    // Only the trace endpoint returns { trace: string[] }; leave other
    // shapes untouched so this interceptor stays globally safe.
    if (
      typeof result === 'object' &&
      result !== null &&
      Array.isArray((result as { trace?: unknown }).trace)
    ) {
      (result as { trace: string[] }).trace.push('response-interceptor');
    }
    return result;
  }
}

@Controller('/health')
@ApiTags('health')
class HealthController {
  @Get()
  @ApiResponse(200, { description: 'Service is up' })
  handle() {
    return { status: 'ok' };
  }
}

@Controller('/who-am-i')
class WhoAmIController {
  @Get()
  handle(@Req() c: Context) {
    return { user: c.req.header('x-user') ?? 'anonymous' };
  }
}

@Controller('/order-test')
class OrderTestController {
  @Get()
  handle(@Req() c: Context) {
    const req = c.req.raw;
    pushTrace(req, 'handler');
    return { trace: traces.get(req) ?? [] };
  }
}

// Singleton controller; resolves REQUEST_CONTEXT off the per-request child
// container through the Hono context. The standard test suite covers the
// @Inject(REQUEST_CONTEXT) constructor path under SWC; the workerd pool's
// transpiler does not emit `design:paramtypes`, so we exercise the resolve
// path that doesn't depend on constructor metadata.
@Controller('/req-ctx')
class RequestContextController {
  @Get()
  handle(@Req() c: Context) {
    const ctx = getRequestContainer(c).resolve(REQUEST_CONTEXT);
    return {
      id: ctx.id,
      receivedAt: ctx.receivedAt.toISOString(),
      hasRawRequest: ctx.request instanceof Request,
    };
  }
}

// Request-scope bubbling: a request-scoped provider @Inject'd into a singleton
// controller must rebuild the controller per request. Critically, workerd's
// transpiler emits no `design:paramtypes`, so this proves bubbling works from
// @Inject metadata alone.
let bubbleCounter = 0;

@Injectable({ scope: Scope.REQUEST })
class RequestCounter {
  readonly n = ++bubbleCounter;
}

@Controller('/bubble')
class BubbleController {
  constructor(@Inject(RequestCounter) private readonly counter: RequestCounter) {}
  @Get()
  handle() {
    return { n: this.counter.n };
  }
}

// i18n end-to-end: also proves `intl-messageformat` bundles + runs under workerd.
@Controller('/i18n')
class I18nSmokeController {
  constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
  @Get()
  handle() {
    return { msg: this.i18n.t('greeting', { name: 'Ada' }), locale: this.i18n.getLocale() };
  }
}

// Storage HMAC signing via Web Crypto (crypto.subtle) under real workerd.
@Controller('/sign-check')
class SignCheckController {
  @Get()
  async handle() {
    const secret = 'smoke-secret';
    const scope = { method: 'GET', purpose: 'workers:storage-smoke' } as const;
    const signed = await signUrl('/storage/uploads/a.png?method=GET', secret, {
      expiresIn: 60,
      ...scope,
    });
    return {
      valid: await verifySignedUrl(signed, secret, scope),
      tampered: await verifySignedUrl(signed.replace('a.png', 'b.png'), secret, scope),
    };
  }
}

// Named-route URL generation + signed-URL guard end-to-end under workerd:
// `signedUrl()` builds + HMAC-signs a named route via Web Crypto, and
// `SignedUrlGuard` verifies the same signature on the way back in.
const WORKERS_SIGNING_SECRET = 'workerd-signing-secret';

@Global()
@Module({
  providers: [defineProvider(URL_SIGNING_SECRET, { useValue: WORKERS_SIGNING_SECRET })],
  exports: [URL_SIGNING_SECRET],
})
class SigningModule {}

@Controller('/signed')
class SignedUrlDemoController {
  constructor(@Inject(UrlGeneratorService) private readonly urls: UrlGeneratorService) {}

  @Get('make')
  async make() {
    return { url: await this.urls.signedUrl('workers.protected', {}, { expiresIn: 60 }) };
  }

  @Get('protected', { name: 'workers.protected' })
  @SignedUrl()
  protectedRoute() {
    return { ok: true };
  }
}

@Module({
  imports: [
    SigningModule,
    I18nModule.forRoot({ defaultLocale: 'en', locales: ['en', 'fr'] }),
    I18nModule.registerMessages({
      en: { greeting: 'Hello, {name}!' },
      fr: { greeting: 'Bonjour, {name} !' },
    }),
  ],
  controllers: [
    HealthController,
    WhoAmIController,
    OrderTestController,
    RequestContextController,
    BubbleController,
    I18nSmokeController,
    SignCheckController,
    SignedUrlDemoController,
  ],
  providers: [
    RequestCounter,
    TraceGuard,
    TracePipe,
    TraceInterceptor,
    defineProvider(APP_GUARD, { useClass: TraceGuard }),
    defineProvider(APP_PIPE, { useClass: TracePipe }),
    defineProvider(APP_INTERCEPTOR, { useClass: TraceInterceptor }),
  ],
})
class SmokeAppModule {}

let cached: VelaApplication | null = null;

async function getApp(): Promise<VelaApplication> {
  if (cached) return cached;
  const app = await VelaFactory.create(SmokeAppModule);
  const doc = createOpenApiDocument(SmokeAppModule, {
    info: { title: 'vela smoke', version: '0.0.0' },
  });
  app.mountOpenApi({ document: doc, specPath: '/docs.json' });
  cached = app;
  return app;
}

export default {
  async fetch(request: Request, _env: unknown, _ctx: unknown): Promise<Response> {
    const app = await getApp();
    return app.fetch(request);
  },
} satisfies ExportedHandler;

declare global {
  interface ExportedHandler<Env = unknown> {
    fetch?(request: Request, env: Env, ctx: unknown): Response | Promise<Response>;
  }
}
