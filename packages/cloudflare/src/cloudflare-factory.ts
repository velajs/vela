import type { ExecutionContext } from 'hono';
import { getConnInfo } from 'hono/cloudflare-workers';
import { VelaFactory } from '@velajs/vela';
import type {
  RuntimeAdapter,
  Type,
  VelaEnv,
  VelaMiddlewareHandler,
  VelaSecurityOptions,
} from '@velajs/vela';
import { CloudflareApplication } from './cloudflare-application';
import { assertCloudflareEnvironment, registerCloudflareEnvironment } from './environment';
import { reportCloudflareScheduleDiagnostics } from './schedule-diagnostics';
import { registerCloudflareScheduledEvent, type ScheduledEvent } from './scheduled-event';
import { warnWorkerLocalLive } from './websocket/do-live';
import { registerWebSocketRoutes } from './websocket/websocket-routing';
import { bootstrapCloudflareRoot } from './root-module';
import type { CloudflareRoot } from './root-module';

export interface CloudflareWorkerOptions {
  globalPrefix?: string;
  security?: VelaSecurityOptions;
  /** Build request middleware from the same native environment DI receives as ENV. */
  middleware?: (env: VelaEnv) => VelaMiddlewareHandler[];
  /** Further runtime adapters, composed after the Cloudflare adapter for each application. */
  adapters?: RuntimeAdapter[];
}

export interface CreateCloudflareAppOptions extends CloudflareWorkerOptions {
  /** Supply the platform environment inside fetch/queue/scheduled or a DO constructor. */
  env: VelaEnv;
}

/**
 * Bind an application to one environment: seeded as the global ENV before
 * provider factories and lifecycle hooks, and asserted on every request. The
 * adapter also supplies the `InternalDispatcher` transport, so signed queue and
 * schedule dispatch re-enter this application's routes, and reports schedule
 * declarations a cron trigger cannot honor through the diagnostics policy.
 */
export function cloudflareAdapter(options: { env: VelaEnv }): RuntimeAdapter {
  const { env } = options;
  return {
    name: 'cloudflare',
    requestMiddleware: [
      async (context, next) => {
        assertCloudflareEnvironment(env, context.env);
        await next();
      },
    ],
    invocationTransport:
      ({ app }) =>
      (request) =>
        Promise.resolve(app.fetch(request, env)),
    getClientIp: (c) => getConnInfo(c).remote.address ?? null,
    configureContainer: (container) => {
      registerCloudflareEnvironment(container, env);
      registerCloudflareScheduledEvent(container);
    },
    onBootstrap: async ({ app, container }) => {
      reportCloudflareScheduleDiagnostics(container, app.entrypoints);
      await warnWorkerLocalLive(container);
    },
  };
}

/**
 * Build an application for one native Workers environment. Call inside a platform event.
 * A `{ create(env) }` root runs once per environment, and every application built for
 * that environment reuses its module graph. Values created in `create(env)`, such as
 * `useValue` providers and module option objects, are therefore shared by all of those
 * applications and Durable Object instances. Build per-application state in factories
 * (`useFactory`, `forRootAsync`, `driver: () => ...`), which run for each application.
 */
export async function createCloudflareApp(
  rootModule: CloudflareRoot,
  options: CreateCloudflareAppOptions,
): Promise<CloudflareApplication> {
  return bootstrapCloudflareRoot(rootModule, options.env, (root) =>
    buildApplication(root, options),
  );
}

async function buildApplication(
  root: Type,
  options: CreateCloudflareAppOptions,
): Promise<CloudflareApplication> {
  const velaApp = await VelaFactory.create(root, {
    globalPrefix: options.globalPrefix,
    security: options.security,
    middleware: options.middleware?.(options.env),
    adapters: [cloudflareAdapter(options), ...(options.adapters ?? [])],
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
 * Worker entrypoint with one bootstrap per environment identity. Concurrent cold
 * events share construction; failed construction is evicted so the next event
 * can retry. Weak keys stop this cache from retaining a replaced environment,
 * but classes a root declares stay in the isolate-global metadata registry with
 * the values their metadata captures, so roots resolve once per environment
 * rather than once per application.
 */
export function createCloudflareWorker(
  rootModule: CloudflareRoot,
  options: CloudflareWorkerOptions = {},
) {
  const applications = new WeakMap<VelaEnv, Promise<CloudflareApplication>>();
  const application = (env: VelaEnv): Promise<CloudflareApplication> => {
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
    async fetch(request: Request, env: VelaEnv, ctx: ExecutionContext): Promise<Response> {
      return (await application(env)).fetch(request, env, ctx);
    },
    async scheduled(
      event: ScheduledEvent,
      env: VelaEnv,
      ctx?: { waitUntil: (promise: Promise<unknown>) => void },
    ): Promise<void> {
      return (await application(env)).scheduled(event, env, ctx);
    },
    async queue(
      batch: { queue: string; messages: readonly unknown[] },
      env: VelaEnv,
      ctx: { waitUntil: (promise: Promise<unknown>) => void },
    ): Promise<void> {
      return (await application(env)).queue(batch, env, ctx);
    },
  };
}
