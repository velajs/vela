import type { ExecutionContext } from 'hono';
import { getConnInfo } from 'hono/cloudflare-workers';
import { VelaFactory } from '@velajs/vela';
import type {
  InjectionToken,
  RuntimeAdapter,
  VelaMiddlewareHandler,
  VelaSecurityOptions,
} from '@velajs/vela';
import { CloudflareApplication } from './cloudflare-application';
import { assertCloudflareEnvironment, registerCloudflareEnvironment } from './environment';
import { registerWebSocketRoutes } from './websocket/websocket-routing';
import { resolveCloudflareRoot } from './root-module';
import type { CloudflareRoot } from './root-module';

export interface CloudflareWorkerOptions<T extends object> {
  /** Global typed DI token for the platform's native environment. */
  envToken: InjectionToken<T>;
  globalPrefix?: string;
  security?: VelaSecurityOptions;
  /** Build request middleware from the same typed native environment as DI. */
  middleware?: (env: NoInfer<T>) => VelaMiddlewareHandler[];
}

export interface CreateCloudflareAppOptions<T extends object> extends CloudflareWorkerOptions<T> {
  /** Supply the platform environment inside fetch/queue/scheduled or a DO constructor. */
  env: NoInfer<T>;
}

/** Bind an application to one environment before provider factories and lifecycle hooks. */
export function cloudflareAdapter<T extends object>(
  options: CreateCloudflareAppOptions<T>,
): RuntimeAdapter {
  return {
    name: 'cloudflare',
    requestMiddleware: [
      async (context, next) => {
        assertCloudflareEnvironment(options.env, context.env);
        await next();
      },
    ],
    invocationTransport:
      ({ app }) =>
      (request) =>
        Promise.resolve(app.fetch(request, options.env)),
    getClientIp: (c) => getConnInfo(c).remote.address ?? null,
    configureContainer: (container) => {
      registerCloudflareEnvironment(container, { token: options.envToken, env: options.env });
    },
  };
}

/** Build an application for one native Workers environment. Call inside a platform event. */
export async function createCloudflareApp<T extends object>(
  rootModule: CloudflareRoot<NoInfer<T>>,
  options: CreateCloudflareAppOptions<T>,
): Promise<CloudflareApplication<T>> {
  const velaApp = await VelaFactory.create(await resolveCloudflareRoot(rootModule, options.env), {
    globalPrefix: options.globalPrefix,
    security: options.security,
    middleware: options.middleware?.(options.env),
    adapters: [cloudflareAdapter(options)],
  });
  const app = new CloudflareApplication(velaApp, options.env);
  const consumers = new Map<string, string>();
  for (const entry of [
    ...app.entrypoints.ofKind('cf:queue'),
    ...app.entrypoints.ofKind('cf:queue:module'),
  ]) {
    const meta = entry.meta;
    if (
      typeof meta !== 'object' ||
      meta === null ||
      !('queueName' in meta) ||
      typeof meta.queueName !== 'string'
    ) {
      await app.close();
      throw new TypeError('Invalid queue consumer metadata.');
    }
    const previous = consumers.get(meta.queueName);
    // Existing native fan-out remains available; module routing owns a queue exclusively.
    if (previous && (previous === 'cf:queue:module' || entry.kind === 'cf:queue:module')) {
      await app.close();
      throw new Error(`Ambiguous consumer ownership for queue '${meta.queueName}'.`);
    }
    consumers.set(meta.queueName, entry.kind);
  }
  app.scanInstances(velaApp.getInstances());
  registerWebSocketRoutes(app.getHonoApp(), app.getWsGatewayRoutes());
  return app;
}

/**
 * Worker entrypoint with one bootstrap per environment identity. Weak keys let
 * obsolete environments and secrets be collected. Concurrent cold events share
 * construction; failed construction is evicted so the next event can retry.
 */
export function createCloudflareWorker<T extends object>(
  rootModule: CloudflareRoot<NoInfer<T>>,
  options: CloudflareWorkerOptions<T>,
) {
  const applications = new WeakMap<T, Promise<CloudflareApplication<T>>>();
  const application = (env: T): Promise<CloudflareApplication<T>> => {
    const existing = applications.get(env);
    if (existing) return existing;
    const pending = createCloudflareApp(rootModule, { ...options, env });
    applications.set(env, pending);
    void pending.catch(() => {
      if (applications.get(env) === pending) applications.delete(env);
    });
    return pending;
  };
  return {
    async fetch(request: Request, env: T, ctx: ExecutionContext): Promise<Response> {
      return (await application(env)).fetch(request, env, ctx);
    },
    async scheduled(
      event: { cron: string; scheduledTime?: number },
      env: T,
      ctx: { waitUntil: (promise: Promise<unknown>) => void },
    ): Promise<void> {
      return (await application(env)).scheduled(event, env, ctx);
    },
    async queue(
      batch: { queue: string; messages: readonly unknown[] },
      env: T,
      ctx: { waitUntil: (promise: Promise<unknown>) => void },
    ): Promise<void> {
      return (await application(env)).queue(batch, env, ctx);
    },
  };
}
