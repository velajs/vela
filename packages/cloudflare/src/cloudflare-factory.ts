import type { ExecutionContext } from 'hono';
import { VelaFactory } from '@velajs/vela';
import type {
  CorsOptions,
  GlobalPrefixOptions,
  Type,
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
import { defineWorkerEvents } from './worker-events';
import { withRootProviders, type CloudflareRoot } from './root-module';

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
          `QueueModule.forFeature([{ consumer: '${queue}' }]) both claim it. Keep one owner.`,
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
 * The well-known key under which a Worker entry (`defineCloudflareApp().worker`
 * or `createCloudflareWorker()`) carries its {@link CloudflareWorkerDescriptor}:
 * `Symbol.for('vela.cloudflare.worker')`.
 */
export const CLOUDFLARE_WORKER: unique symbol = Symbol.for('vela.cloudflare.worker');

/**
 * The well-known static key under which a Durable Object class that
 * `VelaDurableObject()` or `VelaWebSocketDurableObject()` returns (and every
 * class extending it) carries its {@link CloudflareDurableObjectDescriptor}:
 * `Symbol.for('vela.cloudflare.durableObject')`.
 */
export const CLOUDFLARE_DURABLE_OBJECT: unique symbol = Symbol.for('vela.cloudflare.durableObject');

/**
 * The well-known static key under which a Workflow class that `VelaWorkflow()`
 * returns (and every class extending it) carries its
 * {@link CloudflareWorkflowDescriptor}: `Symbol.for('vela.cloudflare.workflow')`.
 */
export const CLOUDFLARE_WORKFLOW: unique symbol = Symbol.for('vela.cloudflare.workflow');

/**
 * The well-known static key under which a service entrypoint class that
 * `VelaEntrypoint()` returns (and every class extending it) carries its
 * {@link CloudflareEntrypointDescriptor}: `Symbol.for('vela.cloudflare.entrypoint')`.
 */
export const CLOUDFLARE_ENTRYPOINT: unique symbol = Symbol.for('vela.cloudflare.entrypoint');

/** What a Vela Durable Object class is built from, for tools such as `vela cf sync`. */
export interface CloudflareDurableObjectDescriptor {
  /**
   * `host`: `VelaDurableObject(root, Host, { rpc })`, whose RPC methods are
   * the host methods `rpc` names.
   * `websocket`: `VelaWebSocketDurableObject(root)`, a gateway room's sockets.
   */
  readonly kind: 'host' | 'websocket';
  readonly rootModule: CloudflareRoot;
  /** The host class of a `host` Durable Object. */
  readonly host?: Type;
  /** The RPC methods the class exposes. */
  readonly methods: readonly string[];
  /** The class the factory returned: an exported Durable Object class extends it. */
  readonly durableObject: abstract new (...args: never[]) => unknown;
}

/** What a Vela Workflow class is built from, for tools such as `vela cf sync`. */
export interface CloudflareWorkflowDescriptor {
  readonly rootModule: CloudflareRoot;
  /** The host class whose `run(event, step)` each Workflow run calls. */
  readonly host: Type;
  /** The class `VelaWorkflow()` returned: an exported Workflow class extends it. */
  readonly workflow: abstract new (...args: never[]) => unknown;
}

/** What a Vela service entrypoint class is built from, for tools such as `vela cf sync`. */
export interface CloudflareEntrypointDescriptor {
  readonly rootModule: CloudflareRoot;
  /** The host class whose methods `methods` names. */
  readonly host: Type;
  /** The RPC methods the class exposes. */
  readonly methods: readonly string[];
  /** The class `VelaEntrypoint()` returned: an exported entrypoint class extends it. */
  readonly entrypoint: abstract new (...args: never[]) => unknown;
}

/** What a Worker entry is built from, for tools that load it outside a platform event. */
export interface CloudflareWorkerDescriptor {
  readonly rootModule: CloudflareRoot;
  readonly options: CloudflareWorkerOptions;
  /**
   * The Durable Object classes defined from the same {@link CloudflareApp}
   * (`VelaDurableObject(app, Host)`, `VelaWebSocketDurableObject(app)`), in
   * definition order; empty for `createCloudflareWorker()`.
   */
  readonly durableObjects: readonly CloudflareDurableObjectDescriptor[];
  /** The Workflow classes defined from the app (`VelaWorkflow(app, Host)`), in definition order. */
  readonly workflows: readonly CloudflareWorkflowDescriptor[];
  /**
   * The service entrypoint classes defined from the app
   * (`VelaEntrypoint(app, Host, { rpc })`), in definition order.
   */
  readonly entrypoints: readonly CloudflareEntrypointDescriptor[];
  /** The `VelaFactory.create()` options the Worker builds its application with for `env`. */
  createOptions(env: VelaEnv): VelaCreateOptions;
  /**
   * `VelaFactory.create()` of the Worker's root (the root module, with the
   * hosts of the app's Workflow and service entrypoint classes among its
   * providers) and `createOptions(env)`: the application without its Worker
   * handlers or the `configure` hook, which receives the Workers application.
   */
  createApplication(env: VelaEnv): Promise<VelaApplication>;
}

/** The exported handlers of a Worker entry (`defineCloudflareApp().worker`, `createCloudflareWorker()`). */
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
   * The Email Workers handler, present once a module imports `OnEmail` from
   * `@velajs/cloudflare/email`: it runs the application's `@OnEmail()`
   * handlers, and rejects a message none of them accepts.
   */
  readonly email?: (
    message: ForwardableEmailMessage,
    env: VelaEnv,
    ctx?: ExecutionContext,
  ) => Promise<void>;
  /**
   * The Tail Workers handler, present once a module imports `OnTail` from
   * `@velajs/cloudflare/tail`: it runs the application's `@OnTail()` handlers
   * and never rejects, even when the application fails to start (the error is
   * logged to the console, and the next batch retries).
   */
  readonly tail?: (events: TraceItem[], env: VelaEnv, ctx?: ExecutionContext) => Promise<void>;
  /**
   * Symbol-keyed, so the platform, which reads string-keyed handlers, ignores
   * it; enumerable, so `{ ...worker, email }` keeps it for the CLI.
   */
  readonly [CLOUDFLARE_WORKER]: CloudflareWorkerDescriptor;
}

/**
 * One Cloudflare application: a static root module and its options, shared
 * by the Worker's default export and every Durable Object, Workflow and
 * service entrypoint class defined from it. Create it once, at module scope
 * of the Worker entry, with {@link defineCloudflareApp}.
 */
export interface CloudflareApp {
  readonly rootModule: CloudflareRoot;
  readonly options: CloudflareWorkerOptions;
  /**
   * The Worker's handlers (`export default app.worker`): one application per
   * environment identity, built on the first event and shared by concurrent
   * cold events, the app's Workflows and its service entrypoints.
   */
  readonly worker: CloudflareWorker;
  /** The Durable Object classes defined from this app, in definition order. */
  readonly durableObjects: readonly CloudflareDurableObjectDescriptor[];
  /** The Workflow classes defined from this app, in definition order. */
  readonly workflows: readonly CloudflareWorkflowDescriptor[];
  /** The service entrypoint classes defined from this app, in definition order. */
  readonly entrypoints: readonly CloudflareEntrypointDescriptor[];
}

/** What an app definition records beyond its public members. */
interface AppState {
  readonly durableObjects: CloudflareDurableObjectDescriptor[];
  readonly workflows: CloudflareWorkflowDescriptor[];
  readonly entrypoints: CloudflareEntrypointDescriptor[];
  readonly application: (env: VelaEnv) => Promise<CloudflareApplication>;
  /** Whether the Worker started building an application: its providers are then fixed. */
  started: boolean;
}

const states = new WeakMap<object, AppState>();

/** Whether `value` is an app {@link defineCloudflareApp} returned. */
export function isCloudflareApp(value: unknown): value is CloudflareApp {
  return typeof value === 'object' && value !== null && states.has(value);
}

function stateOf(app: unknown, factory: string): AppState {
  const state = typeof app === 'object' && app !== null ? states.get(app) : undefined;
  if (state === undefined) {
    throw new TypeError(
      `${factory}() takes the app from defineCloudflareApp(AppModule, options), whose Worker ` +
        'application it runs in: define the app once and pass it.',
    );
  }
  return state;
}

/**
 * @internal Record a Durable Object class defined from `app`, so the Worker
 * descriptor lists it. The `@velajs/cloudflare/durable-objects` factories call
 * it at class definition.
 */
export function registerDurableObject(
  app: CloudflareApp,
  descriptor: CloudflareDurableObjectDescriptor,
): void {
  states.get(app)?.durableObjects.push(descriptor);
}

/** Hosts join the Worker's root providers, so they must be declared before it is built. */
function assertNotStarted(state: AppState, factory: string, host: Type): void {
  if (!state.started) return;
  throw new Error(
    `${factory}(app, ${host.name}) was called after the app started building its Worker ` +
      'application, whose providers are then fixed: define Workflow and service entrypoint ' +
      'classes at module scope, in the module that defines the app.',
  );
}

/**
 * @internal Record a Workflow class defined from `app`: its host joins the
 * Worker application's root providers, and the Worker descriptor lists it.
 * `VelaWorkflow()` calls it at class definition; `app` is validated here.
 */
export function registerWorkflow(app: unknown, descriptor: CloudflareWorkflowDescriptor): void {
  const state = stateOf(app, 'VelaWorkflow');
  assertNotStarted(state, 'VelaWorkflow', descriptor.host);
  state.workflows.push(descriptor);
}

/**
 * @internal Record a service entrypoint class defined from `app`: its host
 * joins the Worker application's root providers, and the Worker descriptor
 * lists it. `VelaEntrypoint()` calls it at class definition; `app` is
 * validated here.
 */
export function registerEntrypoint(app: unknown, descriptor: CloudflareEntrypointDescriptor): void {
  const state = stateOf(app, 'VelaEntrypoint');
  assertNotStarted(state, 'VelaEntrypoint', descriptor.host);
  state.entrypoints.push(descriptor);
}

/**
 * @internal The Worker's application for `env`: the one its handlers use,
 * built on first use for each environment identity and shared by concurrent
 * events, so the app's Workflows and service entrypoints run in it too.
 */
export function cloudflareApplication(
  app: CloudflareApp,
  env: VelaEnv,
): Promise<CloudflareApplication> {
  return stateOf(app, 'cloudflareApplication').application(env);
}

/**
 * Define one Cloudflare application from a static root module (a module class
 * or a `DynamicModule`) and its options. The Worker entry exports its Worker
 * and the Durable Object, Workflow and service entrypoint classes defined from
 * it, which share the root and the options: runtime `adapters` configure every
 * application and Durable Object context the app builds.
 *
 * ```ts
 * import { defineCloudflareApp } from '@velajs/cloudflare';
 * import { VelaDurableObject } from '@velajs/cloudflare/durable-objects';
 *
 * const app = defineCloudflareApp(AppModule, { globalPrefix: '/api' });
 * export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
 * export default app.worker;
 * ```
 *
 * The Worker builds one application per environment identity. The app's
 * Workflows (`VelaWorkflow`) and service entrypoints (`VelaEntrypoint`) run in
 * that application, with their hosts added to the root module's providers;
 * each Durable Object instance boots its own application context. Declare the
 * classes in the module that defines the app: a class file importing the app
 * from the Worker entry would run before the entry defined it. Keep them in
 * the entry, or define the app in a module of its own that the entry and the
 * class files import. `createCloudflareWorker` is
 * `defineCloudflareApp(rootModule, options).worker`.
 */
export function defineCloudflareApp(
  rootModule: CloudflareRoot,
  options: CloudflareWorkerOptions = {},
): CloudflareApp {
  const { configure, ...appOptions } = options;
  const durableObjects: CloudflareDurableObjectDescriptor[] = [];
  const workflows: CloudflareWorkflowDescriptor[] = [];
  const entrypoints: CloudflareEntrypointDescriptor[] = [];
  // The Worker's root: the root module, with the hosts of the Workflow and
  // service entrypoint classes among its providers.
  const workerRoot = (): CloudflareRoot => {
    const hosts = [...new Set([...workflows, ...entrypoints].map(({ host }) => host))];
    return hosts.length === 0 ? rootModule : withRootProviders(rootModule, hosts);
  };
  // Weak keys stop this cache from retaining a replaced environment.
  const applications = new WeakMap<VelaEnv, Promise<CloudflareApplication>>();
  const build = async (env: VelaEnv): Promise<CloudflareApplication> =>
    configureCloudflareApplication(
      await createCloudflareApp(workerRoot(), { ...appOptions, env }),
      env,
      configure,
    );
  const state: AppState = {
    durableObjects,
    workflows,
    entrypoints,
    started: false,
    // Concurrent cold events share construction, including `configure`; a
    // failed construction is evicted so the next event can retry.
    application: (env) => {
      const existing = applications.get(env);
      if (existing) return existing;
      state.started = true;
      const pending = build(env);
      applications.set(env, pending);
      void pending.catch(() => {
        if (applications.get(env) === pending) applications.delete(env);
      });
      return pending;
    },
  };
  const { application } = state;
  const descriptor: CloudflareWorkerDescriptor = {
    rootModule,
    options,
    durableObjects,
    workflows,
    entrypoints,
    createOptions: (env) => cloudflareCreateOptions({ ...appOptions, env }),
    createApplication: (env) =>
      VelaFactory.create(workerRoot(), cloudflareCreateOptions({ ...appOptions, env })),
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
  // `email` and `tail` appear once a module imports their decorators.
  defineWorkerEvents(worker, application);
  const app: CloudflareApp = {
    rootModule,
    options,
    worker,
    durableObjects,
    workflows,
    entrypoints,
  };
  states.set(app, state);
  return app;
}

/**
 * Worker entrypoint with one bootstrap per environment identity: the Worker of
 * `defineCloudflareApp(rootModule, options)`. Concurrent cold events share
 * construction, including `configure`; failed construction is evicted so the
 * next event can retry. Define the app with {@link defineCloudflareApp} when the
 * entry also exports Durable Object classes built from it.
 */
export function createCloudflareWorker(
  rootModule: CloudflareRoot,
  options: CloudflareWorkerOptions = {},
): CloudflareWorker {
  return defineCloudflareApp(rootModule, options).worker;
}
