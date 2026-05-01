import type { Hono } from 'hono';
import { CRON_METADATA, getMetadata, type VelaApplication } from '@velajs/vela';
import type { CronMetadata } from '@velajs/vela';
import { getScheduledMetadata } from './decorators/scheduled';
import { getQueueConsumerMetadata } from './decorators/queue-consumer';
import type { ScheduledRegistration, QueueRegistration, CloudflareEnv } from './types';

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
 */
export class CloudflareApplication {
  private scheduledHandlers: ScheduledRegistration[] = [];
  private queueConsumers: QueueRegistration[] = [];

  constructor(private app: VelaApplication) {}

  get fetch(): Hono['fetch'] {
    return this.app.fetch;
  }

  getHonoApp(): Hono {
    return this.app.getHonoApp();
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
    }
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
