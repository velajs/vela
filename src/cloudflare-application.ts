import type { Hono } from 'hono';
import {
  CRON_METADATA,
  PipelineRunner,
  buildEntrypointExecutionContext,
  registerEntrypointKind,
  runInEntrypointScope,
  shouldFilterCatch,
  type VelaApplication,
} from '@velajs/vela';
import type { CronMetadata, Entrypoint, Type } from '@velajs/vela';
import { ComponentManager } from '@velajs/vela/internal';
import { dispatchInboundEmail, parseInboundEmail } from '@velajs/mail';
import type { ScheduledMetadata } from './decorators/scheduled';
import type { QueueConsumerMetadata } from './decorators/queue-consumer';
import { collectWsGatewayRoutes, type WsGatewayRoute } from './websocket/websocket-routing';
import type { CloudflareEnv } from './types';

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

type Method = (...args: unknown[]) => unknown;

function invoke(instance: object, methodName: string, args: unknown[]): unknown {
  const method = (instance as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') {
    throw new Error(`Method '${methodName}' is not a function on ${instance.constructor.name}`);
  }
  return (method as Method).apply(instance, args);
}

/**
 * Wraps VelaApplication with Cloudflare-specific handlers:
 * - `fetch` — HTTP request handler (from Hono)
 * - `scheduled` — Cron trigger handler (matches `@Scheduled()` decorators
 *                 AND vela's own `@Cron()` jobs)
 * - `queue` — Queue consumer handler (matches `@QueueConsumer()` decorators)
 * - `email` — Email Routing handler (dispatches `@OnInboundEmail()` handlers
 *             from `@velajs/mail` after fail-closed verdict gating)
 * - `mountOpenApi` — Serve an OpenAPI document (and optional Scalar UI) on
 *                    the underlying Hono app
 *
 * @example
 * ```ts
 * const app = await createCloudflareApp(AppModule);
 * export default {
 *   fetch: app.fetch,
 *   scheduled: app.scheduled.bind(app),
 *   queue: app.queue.bind(app),
 *   email: app.email.bind(app),
 * };
 * ```
 *
 * @example
 * ```ts
 * // Serve OpenAPI docs alongside your routes
 * const app = await createCloudflareApp(AppModule);
 * const document = createOpenApiDocument(AppModule);
 * app.mountOpenApi({ document, ui: 'scalar' });
 * // GET /openapi.json -> JSON document
 * // GET /scalar       -> Scalar UI (loads from CDN)
 * ```
 */
export class CloudflareApplication {
  private wsGatewayRoutes: WsGatewayRoute[] = [];

  constructor(private app: VelaApplication) {}

  get fetch(): Hono['fetch'] {
    return this.app.fetch;
  }

  getHonoApp(): Hono {
    return this.app.getHonoApp();
  }

  /**
   * Resolve a provider from the application's DI container (delegates to
   * `VelaApplication.get`). Handy for grabbing a service — e.g. an auth service —
   * to use inside `createCloudflareApp({ middleware: [...] })` request middleware,
   * which runs outside the DI request pipeline.
   *
   * @example
   * ```ts
   * const app = await createCloudflareApp(AppModule);
   * const auth = app.get<BetterAuthService>(BetterAuthService);
   * ```
   */
  get<T>(token: Parameters<VelaApplication['get']>[0]): T {
    return this.app.get(token) as T;
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
   * const app = await createCloudflareApp(AppModule);
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
    env: CloudflareEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const handlers = [
      ...this.app.entrypoints
        .ofKind<ScheduledMetadata>('cf:scheduled')
        .map((ep) => ({ ep, cron: ep.meta.cron })),
      ...this.app.entrypoints
        .ofKind<CronMetadata>('cf:vela-cron')
        .map((ep) => ({ ep, cron: ep.meta.expression })),
    ].filter((h) => h.cron === event.cron);

    await Promise.all(handlers.map(({ ep }) => this.dispatchEntrypoint(ep, [event, env, ctx])));
  }

  /**
   * Run one entrypoint handler inside a fresh request scope, through the
   * shared guard → interceptor pipeline (components declared with
   * `@UseGuards`/`@UseInterceptors`/`@UseFilters` on the consumer class or
   * method). HTTP-global components deliberately do NOT apply — an HTTP auth
   * guard has no business rejecting a queue batch. Unclaimed errors rethrow
   * so the platform's retry semantics stay intact.
   */
  private async dispatchEntrypoint(ep: Entrypoint, args: unknown[]): Promise<void> {
    const targetClass = ep.token as Type;
    const methodName = String(ep.methodName);
    const context = buildEntrypointExecutionContext(ep.kind, targetClass, methodName, args[0]);

    await runInEntrypointScope(this.app.getContainer(), async (scope) => {
      const instance = scope.resolve(ep.token) as object;
      const guards = ComponentManager.resolveGuards(
        ComponentManager.getScopedComponents('guard', targetClass, methodName),
        scope,
      );
      const interceptors = ComponentManager.resolveInterceptors(
        ComponentManager.getScopedComponents('interceptor', targetClass, methodName),
        scope,
      );
      // Closest-first, mirroring the HTTP/WS dispatchers.
      const filters = ComponentManager.resolveFilters(
        [...ComponentManager.getScopedComponents('filter', targetClass, methodName)].reverse(),
        scope,
      );

      try {
        await PipelineRunner.run({
          context,
          guards,
          interceptors,
          resolveArgs: async () => args,
          invoke: async (resolved) => invoke(instance, methodName, resolved),
        });
      } catch (error) {
        for (const filter of filters) {
          if (shouldFilterCatch(filter, error)) {
            await filter.catch(error, context);
            return;
          }
        }
        throw error;
      }
    });
  }

  /**
   * Handle Cloudflare Queue consumer events.
   * Matches the batch queue name to `@QueueConsumer()` handlers read from
   * `app.entrypoints`; each batch is processed inside a fresh request-scoped
   * child (request-scoped providers rebuild per batch — no boot-time captives).
   */
  async queue(
    batch: { queue: string; messages: unknown[] },
    env: CloudflareEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const handlers = this.app.entrypoints
      .ofKind<QueueConsumerMetadata>('cf:queue')
      .filter((ep) => ep.meta.queueName === batch.queue);

    await Promise.all(handlers.map((ep) => this.dispatchEntrypoint(ep, [batch, env, ctx])));
  }

  /**
   * Handle Cloudflare Email Routing events (the Worker's `email` handler).
   * Reads the RAW byte stream — NOT `message.headers`, which is a `Headers`
   * object that collapses duplicate `Authentication-Results` headers and would
   * let an attacker-injected lower header win. The SMTP envelope (`from`/`to`)
   * is supplied to `@velajs/mail`'s neutral, CF-free parser; verdict gating and
   * the handler pipeline live entirely in that core (this hook only does I/O).
   *
   * When the app gate rejects the message, `dispatchInboundEmail` runs NO
   * handler (privileged inbound handlers never see an ungated message) and this
   * hook returns a permanent SMTP reject with a FIXED, generic reason — never a
   * verdict name or internal detail, since the sender may be the attacker.
   * A gate-passed message with no matching handler is dropped (the default).
   */
  async email(
    message: ForwardableEmailMessage,
    _env: CloudflareEnv,
    _ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const email = parseInboundEmail(bytes, { from: message.from, to: message.to });
    const result = await dispatchInboundEmail(this.app.getContainer(), this.app.entrypoints, email);
    if (result.gated) {
      message.setReject('message could not be processed');
    }
  }

  async close(signal?: string): Promise<void> {
    return this.app.close(signal);
  }
}
