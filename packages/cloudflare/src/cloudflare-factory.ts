import type { ExecutionContext } from 'hono';
import { VelaFactory } from '@velajs/vela';
import type { CorsOptions, VelaApplication, VelaEnv, VelaSecurityOptions } from '@velajs/vela';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import { CloudflareApplication } from './cloudflare-application';
import { assertCloudflareEnvironment } from './environment';
import { registerCloudflarePlatform } from './platform';
import { reportCloudflareScheduleDiagnostics } from './schedule-diagnostics';
import { registerScheduledEventSeed, type ScheduledEvent } from './scheduled-event';
import { reportUnservedGateways } from './websocket/binding-gateways';
import { workerLivePlatform } from './websocket/live-driver';
import { workerWebSocketTransport } from './websocket/worker-transport';
import type { CloudflareRoot } from './root-module';

export interface CloudflareAppOptions {
  globalPrefix?: string;
  security?: VelaSecurityOptions;
  /** Enable CORS for every route: `true` or `CorsOptions`, as `app.enableCors()` takes. */
  cors?: CorsOptions | boolean;
  /** Further runtime adapters, composed after the Cloudflare adapter for each application. */
  adapters?: RuntimeAdapter[];
}

export interface CloudflareWorkerOptions extends CloudflareAppOptions {
  /**
   * Finish each application's HTTP surface, such as extra Hono routes, once per
   * environment. It runs after the application is built and before any event,
   * including concurrent cold events, reaches it; a throw fails that
   * construction, and the next event retries. It must be synchronous and do no
   * I/O (a returned promise fails the construction): read bindings in
   * providers. Request middleware belongs in modules (`configure(consumer)`),
   * which can inject `ENV`.
   */
  configure?(app: CloudflareApplication, env: VelaEnv): void;
}

export interface CreateCloudflareAppOptions extends CloudflareAppOptions {
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
 * adapter also registers the Worker's platform wiring: `WebSocketModule`
 * forwards each authenticated gateway upgrade to the room's Durable Object,
 * and `LiveModule` sends invalidations there. It supplies the
 * `InternalDispatcher` transport, so signed queue and schedule dispatch
 * re-enter this application's routes, and reports, through the diagnostics
 * policy, schedule declarations a cron trigger cannot honor and binding-backed
 * gateways without `WebSocketModule`.
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
    // Cloudflare attests the client address in this header. Read directly:
    // hono/cloudflare-workers would also load its WebSocket upgrade helper.
    getClientIp: (c) => c.req.header('cf-connecting-ip') ?? null,
    configureContainer: (container) => {
      registerCloudflarePlatform(container, env, {
        websocket: workerWebSocketTransport(env),
        live: workerLivePlatform(env, container),
      });
      registerScheduledEventSeed(container);
    },
    onBootstrap: ({ app, container, discovery }) => {
      assertQueueConsumerOwnership(app.entrypoints);
      reportCloudflareScheduleDiagnostics(container, app.entrypoints);
      reportUnservedGateways(container, discovery);
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
    cors: options.cors,
    adapters: [cloudflareAdapter(options), ...(options.adapters ?? [])],
  });
  return new CloudflareApplication(velaApp, options.env);
}

/**
 * Worker entrypoint with one bootstrap per environment identity. Concurrent cold
 * events share construction, including `configure`; failed construction is
 * evicted so the next event can retry. Weak keys stop this cache from
 * retaining a replaced environment.
 */
export function createCloudflareWorker(
  rootModule: CloudflareRoot,
  options: CloudflareWorkerOptions = {},
) {
  const { configure, ...appOptions } = options;
  const applications = new WeakMap<VelaEnv, Promise<CloudflareApplication>>();
  const build = async (env: VelaEnv): Promise<CloudflareApplication> => {
    const app = await createCloudflareApp(rootModule, { ...appOptions, env });
    if (!configure) return app;
    try {
      const result: unknown = configure(app, env);
      if (result instanceof Promise) {
        // Observe the rejected work; the construction fails either way.
        result.catch(() => {});
        throw new TypeError(
          'createCloudflareWorker configure must finish synchronously: it runs before any ' +
            'event reaches the application, so read bindings and perform I/O in providers.',
        );
      }
    } catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
    return app;
  };
  const application = (env: VelaEnv): Promise<CloudflareApplication> => {
    const existing = applications.get(env);
    if (existing) return existing;
    const pending = build(env);
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
