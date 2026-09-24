import type { ExecutionContext } from 'hono';
import { getConnInfo } from 'hono/cloudflare-workers';
import { VelaFactory } from '@velajs/vela';
import type {
  VelaApplication,
  VelaCreateOptions,
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
 * The `VelaFactory.create()` options an application for `options.env` is built
 * with: the Cloudflare adapter bound to that environment, then any further adapters.
 */
export function cloudflareCreateOptions(options: CreateCloudflareAppOptions): VelaCreateOptions {
  return {
    globalPrefix: options.globalPrefix,
    security: options.security,
    middleware: options.middleware?.(options.env),
    adapters: [cloudflareAdapter(options), ...(options.adapters ?? [])],
  };
}

/** Wrap a built application as the Workers entry serves it: platform handlers and WebSocket upgrades. */
export function toCloudflareApplication(
  velaApp: VelaApplication,
  env: VelaEnv,
): CloudflareApplication {
  const app = new CloudflareApplication(velaApp, env);
  app.scanInstances(velaApp.getInstances());
  registerWebSocketRoutes(app.getHonoApp(), app.getWsGatewayRoutes(), velaApp.getContainer());
  return app;
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
  const velaApp = await VelaFactory.create(rootModule, cloudflareCreateOptions(options));
  return toCloudflareApplication(velaApp, options.env);
}

/**
 * The well-known key under which a `createCloudflareWorker()` entry carries
 * its {@link CloudflareWorkerDescriptor}: `Symbol.for('vela.cloudflare.worker')`.
 */
export const CLOUDFLARE_WORKER: unique symbol = Symbol.for('vela.cloudflare.worker');

/** What a Worker entry is built from, for tools that load it outside a platform event. */
export interface CloudflareWorkerDescriptor {
  readonly rootModule: CloudflareRoot;
  readonly options: CloudflareWorkerOptions;
  /** The `VelaFactory.create()` options the Worker builds its application with for `env`. */
  createOptions(env: VelaEnv): VelaCreateOptions;
  /** `VelaFactory.create(rootModule, createOptions(env))`: the application without its Worker handlers. */
  createApplication(env: VelaEnv): Promise<VelaApplication>;
}

/** The exported handlers of a `createCloudflareWorker()` entry. */
export interface CloudflareWorker {
  fetch(request: Request, env: VelaEnv, ctx: ExecutionContext): Promise<Response>;
  scheduled(
    event: ScheduledEvent,
    env: VelaEnv,
    ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void>;
  queue(
    batch: { queue: string; messages: readonly unknown[] },
    env: VelaEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void>;
  /** Not enumerable: the platform reads only the handlers. */
  readonly [CLOUDFLARE_WORKER]: CloudflareWorkerDescriptor;
}

/**
 * Worker entrypoint with one bootstrap per environment identity. Concurrent cold
 * events share construction; failed construction is evicted so the next event
 * can retry. Weak keys stop this cache from retaining a replaced environment.
 */
export function createCloudflareWorker(
  rootModule: CloudflareRoot,
  options: CloudflareWorkerOptions = {},
): CloudflareWorker {
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
  const descriptor: CloudflareWorkerDescriptor = {
    rootModule,
    options,
    createOptions: (env) => cloudflareCreateOptions({ ...options, env }),
    createApplication: (env) =>
      VelaFactory.create(rootModule, cloudflareCreateOptions({ ...options, env })),
  };
  const worker: CloudflareWorker = {
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
    [CLOUDFLARE_WORKER]: descriptor,
  };
  return Object.defineProperty(worker, CLOUDFLARE_WORKER, { enumerable: false });
}
