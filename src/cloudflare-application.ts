import type { Hono } from 'hono';
import { CRON_METADATA, getMetadata, type VelaApplication } from '@velajs/vela';
import type { CronMetadata } from '@velajs/vela';
import { getScheduledMetadata } from './decorators/scheduled';
import { getQueueConsumerMetadata } from './decorators/queue-consumer';
import { collectWsGatewayRoutes, type WsGatewayRoute } from './websocket/websocket-routing';
import type { ScheduledRegistration, QueueRegistration, CloudflareEnv } from './types';

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
  private scheduledHandlers: ScheduledRegistration[] = [];
  private queueConsumers: QueueRegistration[] = [];
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

  /** @internal — scans instances for @Scheduled, @Cron, and @QueueConsumer metadata */
  scanInstances(instances: unknown[]): void {
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object') continue;

      for (const meta of getScheduledMetadata(instance)) {
        this.scheduledHandlers.push({
          instance,
          methodName: meta.methodName,
          cron: meta.cron,
        });
      }

      // vela's @Cron jobs run via the same Workers cron trigger.
      const cronMeta = (getMetadata(CRON_METADATA, instance.constructor) as CronMetadata[] | undefined) ?? [];
      for (const meta of cronMeta) {
        this.scheduledHandlers.push({
          instance,
          methodName: meta.methodName,
          cron: meta.expression,
        });
      }

      for (const meta of getQueueConsumerMetadata(instance)) {
        this.queueConsumers.push({
          instance,
          methodName: meta.methodName,
          queueName: meta.queueName,
        });
      }

      this.wsGatewayRoutes.push(...collectWsGatewayRoutes(instance));
    }
  }

  /** @internal — upgrade routes discovered from `@WebSocketGateway({ path, binding })`. */
  getWsGatewayRoutes(): WsGatewayRoute[] {
    return this.wsGatewayRoutes;
  }

  /**
   * Handle Cloudflare scheduled (cron) events.
   * Matches the event's cron expression to `@Scheduled()` and vela `@Cron()` handlers.
   */
  async scheduled(
    event: { cron: string; scheduledTime?: number },
    env: CloudflareEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const matching = this.scheduledHandlers.filter((h) => h.cron === event.cron);
    await Promise.all(
      matching.map((h) => invoke(h.instance as object, h.methodName, [event, env, ctx])),
    );
  }

  /**
   * Handle Cloudflare Queue consumer events.
   * Matches the batch queue name to `@QueueConsumer()` handlers.
   */
  async queue(
    batch: { queue: string; messages: unknown[] },
    env: CloudflareEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const matching = this.queueConsumers.filter((h) => h.queueName === batch.queue);
    await Promise.all(
      matching.map((h) => invoke(h.instance as object, h.methodName, [batch, env, ctx])),
    );
  }

  async close(signal?: string): Promise<void> {
    return this.app.close(signal);
  }
}
