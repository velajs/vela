import type { ExecutionContext } from 'hono';
import { VelaFactory } from '@velajs/vela';
import type {
  CorsOptions,
  GlobalPrefixOptions,
  VelaApplication,
  VelaCreateOptions,
  VelaEnv,
  VelaSecurityOptions,
  VersioningOptions,
} from '@velajs/vela';
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
  /** Routes served without the global prefix (`{ exclude }`). */
  globalPrefixOptions?: GlobalPrefixOptions;
  /** URI versioning: the version segment prefix (default `'v'`). */
  versioning?: VersioningOptions;
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
 * The `VelaFactory.create()` options an application for `options.env` is built
 * with: that environment (seeded as ENV and sent by test clients as `c.env`),
 * the Cloudflare adapter bound to it, then any further adapters.
 */
export function cloudflareCreateOptions(options: CreateCloudflareAppOptions): VelaCreateOptions {
  return {
    env: options.env,
    globalPrefix: options.globalPrefix,
    globalPrefixOptions: options.globalPrefixOptions,
    versioning: options.versioning,
    security: options.security,
    cors: options.cors,
    adapters: [cloudflareAdapter(options), ...(options.adapters ?? [])],
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
  const velaApp = await VelaFactory.create(rootModule, cloudflareCreateOptions(options));
  return new CloudflareApplication(velaApp, options.env);
}

/**
 * Run a Worker's `configure` hook on the application built for `env`, as
 * `createCloudflareWorker()` does before any event reaches it: a throw or a
 * returned promise closes the application and fails the construction.
 */
export async function configureCloudflareApplication(
  app: CloudflareApplication,
  env: VelaEnv,
  configure: CloudflareWorkerOptions['configure'],
): Promise<CloudflareApplication> {
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
  /**
   * `VelaFactory.create(rootModule, createOptions(env))`: the application
   * without its Worker handlers or the `configure` hook, which receives the
   * Workers application.
   */
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
  /**
   * Symbol-keyed, so the platform, which reads string-keyed handlers, ignores
   * it; enumerable, so `{ ...worker, email }` keeps it for the CLI.
   */
  readonly [CLOUDFLARE_WORKER]: CloudflareWorkerDescriptor;
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
): CloudflareWorker {
  const { configure, ...appOptions } = options;
  const applications = new WeakMap<VelaEnv, Promise<CloudflareApplication>>();
  const build = async (env: VelaEnv): Promise<CloudflareApplication> =>
    configureCloudflareApplication(
      await createCloudflareApp(rootModule, { ...appOptions, env }),
      env,
      configure,
    );
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
  const descriptor: CloudflareWorkerDescriptor = {
    rootModule,
    options,
    createOptions: (env) => cloudflareCreateOptions({ ...appOptions, env }),
    createApplication: (env) =>
      VelaFactory.create(rootModule, cloudflareCreateOptions({ ...appOptions, env })),
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
  return worker;
}
