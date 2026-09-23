import type { ExecutionContext } from 'hono';
import { getConnInfo } from 'hono/cloudflare-workers';
import { VelaFactory } from '@velajs/vela';
import type {
  VelaApplication,
  VelaEnv,
  VelaMiddlewareHandler,
  VelaSecurityOptions,
} from '@velajs/vela';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import { CloudflareApplication } from './cloudflare-application';
import { assertCloudflareEnvironment, registerCloudflareEnvironment } from './environment';
import { reportCloudflareScheduleDiagnostics } from './schedule-diagnostics';
import { registerScheduledEventSeed, type ScheduledEvent } from './scheduled-event';
import { warnWorkerLocalLive } from './websocket/do-live';
import { registerWebSocketRoutes } from './websocket/websocket-routing';
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

function readStrings(meta: unknown, property: string): string[] {
  const value: unknown =
    typeof meta === 'object' && meta !== null ? Reflect.get(meta, property) : undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new TypeError(`Invalid queue consumer metadata: ${property}.`);
}

/**
 * `@QueueConsumer` handlers own their physical queue. A `QueueModule`
 * registration that pins the same physical queue with `consumer` would never
 * see its batches, so bootstrap rejects the overlap.
 */
function assertQueueConsumerOwnership(entrypoints: VelaApplication['entrypoints']): void {
  const pinned = new Set(
    entrypoints.ofKind('cf:queue:module').flatMap((entry) => readStrings(entry.meta, 'consumers')),
  );
  for (const entry of entrypoints.ofKind('cf:queue')) {
    const [queue] = readStrings(entry.meta, 'queueName');
    if (queue !== undefined && pinned.has(queue)) {
      throw new Error(
        `Ambiguous consumer ownership for queue '${queue}': @QueueConsumer('${queue}') and a ` +
          `QueueModule.registerQueue({ consumer: '${queue}' }) both claim it. Keep one owner.`,
      );
    }
  }
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
      registerScheduledEventSeed(container);
    },
    onBootstrap: async ({ app, container }) => {
      assertQueueConsumerOwnership(app.entrypoints);
      reportCloudflareScheduleDiagnostics(container, app.entrypoints);
      await warnWorkerLocalLive(container);
    },
  };
}

/**
 * Build an application for one native Workers environment. Call inside a platform event.
 * The root is static: a module class or a `DynamicModule` declared at module scope.
 * Read bindings in providers (`@InjectEnv()`) and module factories
 * (`forRootAsync({ inject: [ENV], useFactory })`), which run for each application.
 */
export async function createCloudflareApp(
  rootModule: CloudflareRoot,
  options: CreateCloudflareAppOptions,
): Promise<CloudflareApplication> {
  const velaApp = await VelaFactory.create(rootModule, {
    globalPrefix: options.globalPrefix,
    security: options.security,
    middleware: options.middleware?.(options.env),
    adapters: [cloudflareAdapter(options), ...(options.adapters ?? [])],
  });
  const app = new CloudflareApplication(velaApp, options.env);
  app.scanInstances(velaApp.getInstances());
  registerWebSocketRoutes(app.getHonoApp(), app.getWsGatewayRoutes(), velaApp.getContainer());
  return app;
}

/**
 * Worker entrypoint with one bootstrap per environment identity. Concurrent cold
 * events share construction; failed construction is evicted so the next event
 * can retry. Weak keys stop this cache from retaining a replaced environment.
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
