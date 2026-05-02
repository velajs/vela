import type { Context } from 'hono';
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ApiResponse,
  ApiTags,
  Controller,
  Get,
  Injectable,
  Module,
  REQUEST_CONTEXT,
  Req,
  VelaFactory,
  createOpenApiDocument,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type RequestContext,
} from '../../index';
import type { VelaApplication } from '../../application';

// Smoke-test app for the workerd live-runtime suite. Each route exercises
// a different slice of the framework end-to-end.

const TRACE_KEY = '__velaTrace';

interface TracedRequest {
  [TRACE_KEY]?: string[];
}

function pushTrace(req: TracedRequest, label: string): void {
  (req[TRACE_KEY] ??= []).push(label);
}

@Injectable()
class TraceGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    pushTrace(ctx.switchToHttp().getRequest<TracedRequest>(), 'guard');
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
    const req = ctx.switchToHttp().getRequest<TracedRequest>();
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
    const req = c.req.raw as TracedRequest;
    pushTrace(req, 'handler');
    return { trace: req[TRACE_KEY] ?? [] };
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
    const container = c.get('container') as { resolve<T>(t: unknown): T };
    const ctx = container.resolve<RequestContext>(REQUEST_CONTEXT);
    return {
      id: ctx.id,
      receivedAt: ctx.receivedAt.toISOString(),
      hasRawRequest: ctx.request instanceof Request,
    };
  }
}

@Module({
  controllers: [HealthController, WhoAmIController, OrderTestController, RequestContextController],
  providers: [
    TraceGuard,
    TracePipe,
    TraceInterceptor,
    { provide: APP_GUARD, useClass: TraceGuard },
    { provide: APP_PIPE, useClass: TracePipe },
    { provide: APP_INTERCEPTOR, useClass: TraceInterceptor },
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
  app.mountOpenApi({ document: doc, path: '/docs.json' });
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
