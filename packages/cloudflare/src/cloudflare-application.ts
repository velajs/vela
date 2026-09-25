import type { ExecutionContext } from 'hono';
import type { CorsOptions, VelaApplication, ExceptionFilter, VelaEnv } from '@velajs/vela';
import {
  PipelineRunner,
  buildEntrypointExecutionContext,
  getEntrypointModuleId,
  invokeScheduledJob,
  parseCronMetadata,
  resolveEntrypoint,
  resolveScopedComponentsAsync,
  resolveErrorReporter,
  runInEntrypointScope,
  shouldFilterCatch,
} from '@velajs/vela/module-kit';
import type { ScheduleInvocation } from '@velajs/vela/schedule';
import type { Entrypoint } from '@velajs/vela/module-kit';
import { assertCloudflareEnvironment } from './environment';
import {
  CLOUDFLARE_SCHEDULED_EVENT,
  cloudflareScheduledEvent,
  type ScheduledEvent,
} from './scheduled-event';

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

/**
 * `QueueModule`'s native consumer reports each failure of a batch once itself
 * (processor failures where they ran, transport failures on settlement), so
 * its rejection is not reported again here.
 */
const SELF_REPORTING_KINDS = new Set(['cf:queue:module']);

const warnedRawJobs = new Set<string>();

/** The logical queue of a Vela job envelope, without importing the queue subsystem. */
function envelopeQueue(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const queue: unknown = Reflect.get(body, 'queue');
  if (
    typeof queue !== 'string' ||
    typeof Reflect.get(body, 'id') !== 'string' ||
    typeof Reflect.get(body, 'name') !== 'string' ||
    !('data' in body)
  ) {
    return undefined;
  }
  return queue;
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
 * - `scheduled` — Cron trigger handler (runs the `@Cron()` jobs whose
 *                 expression is the trigger's exact string)
 * - `queue` — Queue consumer handler (`@QueueConsumer()` by physical queue,
 *             then `QueueModule`'s native consumer)
 * - `mountOpenApi` — Serve an OpenAPI document (and optional Scalar UI) on
 *                    the underlying Hono app
 *
 * @example
 * ```ts
 * const app = await createCloudflareApp(AppModule, { env });
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
 * const app = await createCloudflareApp(AppModule, { env });
 * const document = createOpenApiDocument(AppModule);
 * app.mountOpenApi({ document, ui: 'scalar' });
 * // GET /openapi.json -> JSON document
 * // GET /scalar       -> Scalar UI (loads from CDN)
 * ```
 */
export class CloudflareApplication {
  readonly #app: VelaApplication;
  /** Scheduled triggers in flight; close() aborts their signals and awaits them. */
  readonly #scheduled = new Map<Promise<void>, AbortController>();

  constructor(
    app: VelaApplication,
    readonly env: VelaEnv,
  ) {
    this.#app = app;
    this.get = app.get.bind(app);
  }

  readonly fetch = async (
    request: Request,
    env: VelaEnv,
    ctx?: ExecutionContext,
  ): Promise<Response> => {
    assertCloudflareEnvironment(this.env, env);
    return this.#app.fetch(request, env, ctx);
  };

  getHonoApp(): ReturnType<VelaApplication['getHonoApp']> {
    return this.#app.getHonoApp();
  }

  /**
   * Resolve a provider from the application's DI container (delegates to
   * `VelaApplication.get`). Handy in `createCloudflareWorker({ configure })`,
   * which finishes the HTTP surface outside the DI request pipeline.
   *
   * @example
   * ```ts
   * const app = await createCloudflareApp(AppModule, { env });
   * const auth = app.get(BetterAuthService);
   * ```
   */
  readonly get: VelaApplication['get'];

  get entrypoints(): VelaApplication['entrypoints'] {
    return this.#app.entrypoints;
  }

  /**
   * The application's DI container (delegates to `VelaApplication.getContainer`),
   * for dispatch seams that take it with `entrypoints`, such as
   * `dispatchInboundEmail(app.getContainer(), app.entrypoints, email)`.
   */
  getContainer(): ReturnType<VelaApplication['getContainer']> {
    return this.#app.getContainer();
  }

  /** Enable CORS for every route, as `VelaApplication.enableCors()`; no rebuild needed. */
  enableCors(options?: CorsOptions): this {
    this.#app.enableCors(options);
    return this;
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
   * import { createOpenApiDocument } from '@velajs/vela/openapi';
   *
   * const app = await createCloudflareApp(AppModule, { env });
   * const document = createOpenApiDocument(AppModule, {
   *   info: { title: 'My API', version: '1.0.0' },
   * });
   * app.mountOpenApi({ document, ui: 'scalar' });
   * // GET /openapi.json -> { openapi: '3.1.0', ... }
   * // GET /scalar       -> Scalar UI HTML
   * ```
   */
  mountOpenApi(options: MountOpenApiOptions): this {
    this.#app.mountOpenApi(options);
    return this;
  }

  /**
   * Handle a Cloudflare cron trigger. Runs every core `@Cron()` job whose
   * expression is exactly `event.cron` (the trigger string is compared as
   * delivered, never re-evaluated) through `invokeScheduledJob`, the dispatch
   * primitive every runtime shares. Each job receives only its
   * `ScheduleInvocation`, runs in a fresh invocation scope seeded with
   * {@link CLOUDFLARE_SCHEDULED_EVENT}, and honors signed `ScheduleModule`
   * dispatch. The trigger settles after every matching job and its managed
   * work (`EXECUTION_LIFETIME.waitUntil`/`defer`) settle; failures reject it.
   */
  async scheduled(
    event: ScheduledEvent,
    env: VelaEnv,
    _ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    assertCloudflareEnvironment(this.env, env);
    const jobs = this.#app.entrypoints
      .ofKind('schedule:cron', parseCronMetadata)
      .filter((entry) => entry.meta.expression === event.cron);
    if (jobs.length === 0) return;

    const controller = new AbortController();
    const scheduledTime = event.scheduledTime ?? Date.now();
    // Shared by every matching job, so none of them can alter what another sees.
    const invocation: ScheduleInvocation = Object.freeze({
      kind: 'cron' as const,
      expression: event.cron,
      scheduledTime,
      signal: controller.signal,
    });
    const trigger = cloudflareScheduledEvent(event, scheduledTime);
    const container = this.#app.getContainer();
    const running = settleEntrypoints(
      jobs.map((entry) =>
        invokeScheduledJob(container, entry, invocation, {
          seed: (scope) => scope.setRequestInstance(CLOUDFLARE_SCHEDULED_EVENT, trigger),
        }),
      ),
    );
    this.#scheduled.set(running, controller);
    try {
      await running;
    } finally {
      this.#scheduled.delete(running);
    }
  }

  /**
   * Run one queue consumer inside a fresh request scope, through the shared
   * guard → interceptor pipeline (components declared with
   * `@UseGuards`/`@UseInterceptors`/`@UseFilters` on the consumer class or
   * method). HTTP-global components deliberately do NOT apply — an HTTP auth
   * guard has no business rejecting a queue batch. Unclaimed errors are
   * reported once (`QueueModule`'s consumer reports its own) and rethrow so
   * the platform's retry semantics stay intact.
   */
  private async dispatchEntrypoint(
    ep: Entrypoint,
    payload: unknown,
    env: VelaEnv,
    platformContext: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const targetClass = ep.token;
    if (typeof targetClass !== 'function') throw new Error('Entrypoint token must be a class.');
    if (ep.methodName === undefined) throw new Error('Entrypoint must declare a handler method.');
    const methodName = ep.methodName;
    const reportContext = {
      edge: 'queue' as const,
      source: `${targetClass.name}.${String(methodName)}`,
    };
    let reported: { error: unknown } | undefined;
    // A self-reporting handler's own rejection was already reported.
    let delegated: { error: unknown } | undefined;
    try {
      await runInEntrypointScope(this.#app.getContainer(), async (scope, lifetime) => {
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
              try {
                return await invoke(instance, methodName, args);
              } catch (error) {
                if (SELF_REPORTING_KINDS.has(ep.kind)) delegated = { error };
                throw error;
              }
            },
          });
        } catch (error) {
          if (delegated?.error !== error) {
            resolveErrorReporter(scope).report(error, reportContext);
          }
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
        resolveErrorReporter(this.#app.getContainer()).report(completionError, reportContext);
      }
      throw error;
    }
  }

  /**
   * Handle Cloudflare Queue consumer events. `@QueueConsumer()` handlers read
   * from `app.entrypoints` claim a batch by its physical queue name and
   * receive it whole. A batch no handler claims goes to `QueueModule`'s native
   * consumer (`cloudflareQueues()` from `@velajs/cloudflare/queues`), which
   * routes each job by its logical queue. Each dispatch runs inside a fresh
   * request-scoped child (request-scoped providers rebuild per batch — no
   * boot-time captives). A batch nothing claims rejects: resolving would let
   * Cloudflare acknowledge every message implicitly.
   */
  async queue(
    batch: { queue: string; messages: readonly unknown[] },
    env: VelaEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    assertCloudflareEnvironment(this.env, env);
    const raw = this.#app.entrypoints
      .ofKind('cf:queue')
      .filter((ep) => entrypointString(ep.meta, 'queueName') === batch.queue);
    if (raw.length > 0) this.warnRawJobs(batch);
    const handlers = raw.length > 0 ? raw : this.#app.entrypoints.ofKind('cf:queue:module');

    if (handlers.length === 0) {
      throw new Error(
        `No consumer claims queue '${batch.queue}'. Add @QueueConsumer('${batch.queue}') to a ` +
          `provider, or deliver it through QueueModule.forRoot({ driver: cloudflareQueues() }) ` +
          `with a QueueModule.registerQueue() for each queue it carries. The batch is rejected ` +
          `unacknowledged, so Cloudflare retries it and then routes it to the configured ` +
          `dead-letter queue.`,
      );
    }

    await settleEntrypoints(handlers.map((ep) => this.dispatchEntrypoint(ep, batch, env, ctx)));
  }

  /**
   * A raw `@QueueConsumer` owns its physical queue's batches and must not carry
   * jobs of a queue registered with `QueueModule`: those reach their
   * `@Processor` only if the raw handler dispatches them itself, while
   * `cloudflareQueues()` delivers registered queues. Warn once per physical and
   * logical queue (unless diagnostics are silent); the raw consumer still
   * receives and settles the batch.
   */
  private warnRawJobs(batch: { queue: string; messages: readonly unknown[] }): void {
    if (this.#app.getContainer().getDiagnostics() === 'silent') return;
    const registered = new Set(
      this.#app.entrypoints
        .ofKind('queue:registration')
        .map((entry) =>
          typeof entry.meta === 'object' && entry.meta !== null
            ? Reflect.get(entry.meta, 'name')
            : undefined,
        ),
    );
    if (registered.size === 0) return;
    for (const message of batch.messages) {
      const body =
        typeof message === 'object' && message !== null ? Reflect.get(message, 'body') : undefined;
      const queue = envelopeQueue(body);
      if (queue === undefined || !registered.has(queue)) continue;
      const warning =
        `[vela] @QueueConsumer('${batch.queue}') received jobs of registered queue '${queue}'. ` +
        `The raw consumer owns '${batch.queue}' and must not carry jobs of registered queues: ` +
        `they reach @Processor('${queue}') only if the raw handler dispatches them itself. ` +
        `Deliver '${queue}' through cloudflareQueues() instead: send it to a physical queue ` +
        `that no @QueueConsumer claims.`;
      if (warnedRawJobs.has(warning)) continue;
      warnedRawJobs.add(warning);
      console.warn(warning);
    }
  }

  /**
   * Abort the signals of scheduled jobs still running, wait for them and their
   * managed work to settle, then close the application.
   */
  async close(signal?: string): Promise<void> {
    for (const controller of this.#scheduled.values()) controller.abort();
    await Promise.allSettled(this.#scheduled.keys());
    return this.#app.close(signal);
  }
}
