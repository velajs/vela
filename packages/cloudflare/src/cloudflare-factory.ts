import type { ExecutionContext } from 'hono';
import { getConnInfo } from 'hono/cloudflare-workers';
import { SCHEDULE_DISPATCH, VelaFactory } from '@velajs/vela';
import type {
  Container,
  InjectionToken,
  RuntimeAdapter,
  Type,
  VelaMiddlewareHandler,
  VelaSecurityOptions,
} from '@velajs/vela';
import { CloudflareApplication } from './cloudflare-application';
import { assertCloudflareEnvironment, registerCloudflareEnvironment } from './environment';
import { warnWorkerLocalLive } from './websocket/do-live';
import { registerWebSocketRoutes } from './websocket/websocket-routing';
import { bootstrapCloudflareRoot } from './root-module';
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

/**
 * Scheduled events invoke `@Cron` handlers directly, so a signed schedule
 * policy would silently skip the signed route and its global guards.
 */
async function rejectSignedScheduleDispatch(container: Container): Promise<void> {
  if (!container.has(SCHEDULE_DISPATCH)) return;
  const dispatch = await container.resolveAsync(SCHEDULE_DISPATCH);
  if (dispatch.kind !== 'signed') return;
  throw new Error(
    'A signed ScheduleModule dispatch is not supported by the Cloudflare adapter yet: scheduled ' +
      'events invoke @Cron handlers directly, which would skip the signed route and its global ' +
      "guards. Remove dispatch: { kind: 'signed' } from ScheduleModule.forRoot(), or call " +
      'InternalDispatcher.run() from the @Cron handler to re-enter the signed route explicitly.',
  );
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
    onBootstrap: async ({ container }) => {
      await rejectSignedScheduleDispatch(container);
      await warnWorkerLocalLive(container);
    },
  };
}

/**
 * Build an application for one native Workers environment. Call inside a platform event.
 * A `{ create(env) }` root runs once per environment; applications built for the same
 * environment share its module graph but never its providers or lifecycle state.
 */
export async function createCloudflareApp<T extends object>(
  rootModule: CloudflareRoot<NoInfer<T>>,
  options: CreateCloudflareAppOptions<T>,
): Promise<CloudflareApplication<T>> {
  return bootstrapCloudflareRoot(rootModule, options.env, (root) =>
    buildApplication(root, options),
  );
}

async function buildApplication<T extends object>(
  root: Type,
  options: CreateCloudflareAppOptions<T>,
): Promise<CloudflareApplication<T>> {
  const velaApp = await VelaFactory.create(root, {
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
 * Worker entrypoint with one bootstrap per environment identity. Concurrent cold
 * events share construction; failed construction is evicted so the next event
 * can retry. Weak keys stop this cache from retaining a replaced environment,
 * but classes a root declares stay in the isolate-global metadata registry with
 * the values their metadata captures, so roots resolve once per environment
 * rather than once per application.
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
