import { createWorkerBindingsLabApp } from './app.js';

const appPromise = createWorkerBindingsLabApp();

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const app = await appPromise;
    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
    const app = await appPromise;
    await app.scheduled(event, env as Record<string, unknown>, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): Promise<void> {
    const app = await appPromise;
    await app.queue(
      { queue: batch.queue, messages: [...batch.messages] },
      env as Record<string, unknown>,
      ctx,
    );
  },
};
