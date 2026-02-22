import type { Hono } from 'hono';
import type { VelaApplication } from '@velajs/vela';
import { getScheduledMetadata } from './decorators/scheduled';
import { getQueueConsumerMetadata } from './decorators/queue-consumer';
import type { ScheduledRegistration, QueueRegistration, CloudflareEnv } from './types';

/**
 * Wraps VelaApplication with Cloudflare-specific handlers:
 * - `fetch` — HTTP request handler (from Hono)
 * - `scheduled` — Cron trigger handler (matches `@Scheduled()` decorators)
 * - `queue` — Queue consumer handler (matches `@QueueConsumer()` decorators)
 *
 * @example
 * ```ts
 * const app = await CloudflareFactory.create(AppModule);
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

  /** @internal — scans instances for @Scheduled and @QueueConsumer metadata */
  scanInstances(instances: unknown[]): void {
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object') continue;

      const scheduledMeta = getScheduledMetadata(instance);
      for (const meta of scheduledMeta) {
        this.scheduledHandlers.push({
          instance,
          methodName: meta.methodName,
          cron: meta.cron,
        });
      }

      const queueMeta = getQueueConsumerMetadata(instance);
      for (const meta of queueMeta) {
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
   * Matches the event's cron expression to `@Scheduled()` handlers.
   */
  async scheduled(
    event: { cron: string; scheduledTime?: number },
    env: CloudflareEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    const matching = this.scheduledHandlers.filter((h) => h.cron === event.cron);
    const promises = matching.map((handler) => {
      const method = (handler.instance as Record<string, Function>)[handler.methodName];
      return method.call(handler.instance, event, env, ctx);
    });
    await Promise.all(promises);
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
    const promises = matching.map((handler) => {
      const method = (handler.instance as Record<string, Function>)[handler.methodName];
      return method.call(handler.instance, batch, env, ctx);
    });
    await Promise.all(promises);
  }

  /** Gracefully shut down the application. */
  async close(signal?: string): Promise<void> {
    return this.app.close(signal);
  }
}
