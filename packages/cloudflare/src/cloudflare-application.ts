import type { ExecutionContext } from 'hono';
import {
  CRON_METADATA,
  PipelineRunner,
  buildEntrypointExecutionContext,
  registerEntrypointKind,
  getEntrypointModuleId,
  resolveEntrypoint,
  resolveScopedComponentsAsync,
  resolveErrorReporter,
  runInEntrypointScope,
  shouldFilterCatch,
  type VelaApplication,
} from '@velajs/vela';
import type { Entrypoint, ExceptionFilter } from '@velajs/vela';
import { collectWsGatewayRoutes, type WsGatewayRoute } from './websocket/websocket-routing';
import { assertCloudflareEnvironment } from './environment';

// vela's own @Cron jobs run via the same Workers cron trigger — declare an
// entrypoint kind over vela's metadata key (the open-kind system makes
// cross-package declarations first-class).
registerEntrypointKind({ kind: 'cf:vela-cron', metaKey: CRON_METADATA, level: 'method' });

/**
 * Options accepted by {@link CloudflareApplication.mountOpenApi}.
 *
 * Re-exposes vela's `MountOpenApiOptions` type — derived structurally from
 * the underlying `VelaApplication.mountOpenApi` signature so consumers don't
 * have to reach into vela's internal subpaths to type the argument.
 */
export type MountOpenApiOptions = Parameters<VelaApplication['mountOpenApi']>[0];

function invoke(instance: object, methodName: string | symbol, args: unknown[]): unknown {
  // Decorator metadata names an instance method; inspect it before invoking.
  const method: unknown = Reflect.get(instance, methodName);
  if (typeof method !== 'function') {
    throw new Error(
      `Method '${String(methodName)}' is not a function on ${instance.constructor.name}`,
    );
  }
  return Reflect.apply(method, instance, args);
}

function entrypointString(meta: unknown, property: string): string {
  if (typeof meta !== 'object' || meta === null) throw new Error('Invalid entrypoint metadata.');
  const value: unknown = Reflect.get(meta, property);
  if (typeof value !== 'string')
    throw new Error(`Invalid entrypoint metadata: ${property} must be a string.`);
  return value;
}

/** Wait for every matching handler, even when one fails before its siblings. */
async function settleEntrypoints(work: readonly Promise<void>[]): Promise<void> {
  const outcomes = await Promise.allSettled(work);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple entrypoint handlers failed.');
}

/**
 * Wraps VelaApplication with Cloudflare-specific handlers:
 * - `fetch` — HTTP request handler (from Hono)
 * - `scheduled` — Cron trigger handler (matches `@Scheduled()` decorators
 *                 AND vela's own `@Cron()` jobs)
 * - `queue` — Queue consumer handler (matches `@QueueConsumer()` decorators)
 * - `mountOpenApi` — Serve an OpenAPI document (and optional Scalar UI) on
 *                    the underlying Hono app
 *
 * @example
 * ```ts
 * const app = await createCloudflareApp(AppModule, { env, envToken: ENV });
 * export default {
 *   fetch: app.fetch,
 *   scheduled: app.scheduled.bind(app),
 *   queue: app.queue.bind(app),
 * };
 * ```
 *
 * @example
 * ```ts
 * // Serve OpenAPI docs alongside your routes
 * const app = await createCloudflareApp(AppModule, { env, envToken: ENV });
 * const document = createOpenApiDocument(AppModule);
 * app.mountOpenApi({ document, ui: 'scalar' });
 * // GET /openapi.json -> JSON document
 * // GET /scalar       -> Scalar UI (loads from CDN)
 * ```
 */
export class CloudflareApplication<T extends object = object> {
  private wsGatewayRoutes: WsGatewayRoute[] = [];

  constructor(
    private app: VelaApplication,
    readonly env: T,
  ) {
    this.get = app.get.bind(app);
  }

  readonly fetch = async (request: Request, env: T, ctx?: ExecutionContext): Promise<Response> => {
    assertCloudflareEnvironment(this.env, env);
    return this.app.fetch(request, env, ctx);
  };

  getHonoApp(): ReturnType<VelaApplication['getHonoApp']> {
    return this.app.getHonoApp();
  }

  /**
   * Resolve a provider from the application's DI container (delegates to
   * `VelaApplication.get`). Handy for grabbing a service — e.g. an auth service —
   * to use inside `createCloudflareApp({ middleware: env => [...] })` request middleware,
   * which runs outside the DI request pipeline.
   *
   * @example
   * ```ts
   * const app = await createCloudflareApp(AppModule, { env, envToken: ENV });
   * const auth = app.get(BetterAuthService);
   * ```
   */
  readonly get: VelaApplication['get'];

  get entrypoints(): VelaApplication['entrypoints'] {
    return this.app.entrypoints;
  }

  /**
   * Serve a pre-built OpenAPI document (and optionally a Scalar UI) on the
   * underlying Hono app. Delegates verbatim to `VelaApplication.mountOpenApi`,
   * so the JSON endpoint defaults to `/openapi.json` and the Scalar UI (when
   * opted in) defaults to `/scalar`. Edge-safe — the UI HTML loads Scalar from
   * a CDN at runtime, nothing is bundled server-side.
   *
   * @example
   * ```ts
   * import { createOpenApiDocument } from '@velajs/vela';
   *
   * const app = await createCloudflareApp(AppModule, { env, envToken: ENV });
   * const document = createOpenApiDocument(AppModule, {
   *   info: { title: 'My API', version: '1.0.0' },
   * });
   * app.mountOpenApi({ document, ui: 'scalar' });
   * // GET /openapi.json -> { openapi: '3.1.0', ... }
   * // GET /scalar       -> Scalar UI HTML
   * ```
   */
  mountOpenApi(options: MountOpenApiOptions): this {
    this.app.mountOpenApi(options);
    return this;
  }

  /**
   * @internal — scans instances for `@WebSocketGateway({ path, binding })`
   * upgrade routes. Queue/scheduled handlers are NOT scanned anymore: they
   * come from `app.entrypoints` (`cf:queue` / `cf:scheduled` / `cf:vela-cron`
   * kinds) at dispatch time.
   */
  scanInstances(instances: unknown[]): void {
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object') continue;
      this.wsGatewayRoutes.push(...collectWsGatewayRoutes(instance));
    }
  }

  /** @internal — upgrade routes discovered from `@WebSocketGateway({ path, binding })`. */
  getWsGatewayRoutes(): WsGatewayRoute[] {
    return this.wsGatewayRoutes;
  }

  /**
   * Handle Cloudflare scheduled (cron) events.
   * Matches the event's cron expression to `@Scheduled()` and vela `@Cron()`
   * handlers read from `app.entrypoints`; each handler runs inside a fresh
   * request-scoped child (request-scoped providers rebuild per tick).
   */
  async scheduled(
    event: { cron: string; scheduledTime?: number },
    env: T,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    assertCloudflareEnvironment(this.env, env);
    const handlers = [
      ...this.app.entrypoints
        .ofKind('cf:scheduled')
        .map((ep) => ({ ep, cron: entrypointString(ep.meta, 'cron') })),
      ...this.app.entrypoints
        .ofKind('cf:vela-cron')
        .map((ep) => ({ ep, cron: entrypointString(ep.meta, 'expression') })),
    ].filter((h) => h.cron === event.cron);

    await settleEntrypoints(handlers.map(({ ep }) => this.dispatchEntrypoint(ep, event, env, ctx)));
  }

  /**
   * Run one entrypoint handler inside a fresh request scope, through the
   * shared guard → interceptor pipeline (components declared with
   * `@UseGuards`/`@UseInterceptors`/`@UseFilters` on the consumer class or
   * method). HTTP-global components deliberately do NOT apply — an HTTP auth
   * guard has no business rejecting a queue batch. Unclaimed errors rethrow
   * so the platform's retry semantics stay intact.
   */
  private async dispatchEntrypoint(
    ep: Entrypoint,
    payload: unknown,
    env: T,
    platformContext: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const targetClass = ep.token;
    if (typeof targetClass !== 'function') throw new Error('Entrypoint token must be a class.');
    if (ep.methodName === undefined) throw new Error('Entrypoint must declare a handler method.');
    const methodName = ep.methodName;
    const reportContext = {
      edge: ep.kind === 'cf:queue' ? ('queue' as const) : ('schedule' as const),
      source: `${targetClass.name}.${String(methodName)}`,
    };
    let reported: { error: unknown } | undefined;
    try {
      await runInEntrypointScope(this.app.getContainer(), async (scope, lifetime) => {
        const moduleId = getEntrypointModuleId(scope, ep);
        const context = buildEntrypointExecutionContext(
          ep.kind,
          targetClass,
          methodName,
          payload,
          moduleId,
          scope,
        );
        const invocationContext = {
          waitUntil(promise: Promise<unknown>): void {
            lifetime.waitUntil(promise);
            platformContext.waitUntil(promise);
          },
        };
        let filters: ExceptionFilter[] = [];
        try {
          filters = (
            await resolveScopedComponentsAsync('filter', targetClass, methodName, scope, moduleId)
          ).toReversed();
          const guards = await resolveScopedComponentsAsync(
            'guard',
            targetClass,
            methodName,
            scope,
            moduleId,
          );
          const interceptors = await resolveScopedComponentsAsync(
            'interceptor',
            targetClass,
            methodName,
            scope,
            moduleId,
          );
          await PipelineRunner.run({
            context,
            guards,
            interceptors,
            resolveArgs: async () => [payload, env, invocationContext],
            invoke: async (args) => {
              const instance = await resolveEntrypoint(scope, ep);
              if (typeof instance !== 'object' || instance === null) {
                throw new Error('Entrypoint must resolve to an object.');
              }
              return invoke(instance, methodName, args);
            },
          });
        } catch (error) {
          resolveErrorReporter(scope).report(error, reportContext);
          for (const filter of filters) {
            if (shouldFilterCatch(filter, error)) {
              // Filters run closest-first; this is the framework catch hook.
              // eslint-disable-next-line no-await-in-loop, promise/valid-params
              await filter.catch(error, context);
              return;
            }
          }
          reported = { error };
          throw error;
        }
      });
    } catch (error) {
      // Managed completion happens after the handler's filter boundary. Report
      // a new completion failure without reporting an already-observed handler
      // failure twice; preserve both errors in the rejected invocation.
      if (!reported || reported.error !== error) {
        const completionError =
          reported && error instanceof AggregateError && error.errors[0] === reported.error
            ? error.errors[1]
            : error;
        resolveErrorReporter(this.app.getContainer()).report(completionError, reportContext);
      }
      throw error;
    }
  }

  /**
   * Handle Cloudflare Queue consumer events.
   * Matches the batch queue name to `@QueueConsumer()` handlers read from
   * `app.entrypoints`; each batch is processed inside a fresh request-scoped
   * child (request-scoped providers rebuild per batch — no boot-time captives).
   */
  async queue(
    batch: { queue: string; messages: readonly unknown[] },
    env: T,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    assertCloudflareEnvironment(this.env, env);
    const handlers = this.app.entrypoints
      .ofKind('cf:queue')
      .filter((ep) => entrypointString(ep.meta, 'queueName') === batch.queue);

    await settleEntrypoints(handlers.map((ep) => this.dispatchEntrypoint(ep, batch, env, ctx)));
  }

  async close(signal?: string): Promise<void> {
    return this.app.close(signal);
  }
}
