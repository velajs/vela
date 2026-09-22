import { describe, it, expect, beforeEach } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
  Scope,
  UseGuards,
  UseInterceptors,
} from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import { InjectionToken } from '@velajs/vela';
const env = {};
const envToken = new InjectionToken<object>('test environment');
import { QueueConsumer } from '../decorators/queue-consumer';
beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@QueueConsumer() decorator', () => {
  it('should invoke matching queue consumers', async () => {
    const processed: unknown[] = [];

    @Injectable()
    class EmailWorker {
      @QueueConsumer('email-queue')
      async process(batch: { queue: string; messages: { body: unknown }[] }) {
        for (const msg of batch.messages) {
          processed.push(msg.body);
        }
      }
    }

    @Module({ providers: [EmailWorker] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env, envToken });
    const ctx = { waitUntil: () => {} };

    await app.queue(
      {
        queue: 'email-queue',
        messages: [{ body: { to: 'alice@example.com' } }, { body: { to: 'bob@example.com' } }],
      },
      env,
      ctx,
    );

    expect(processed).toEqual([{ to: 'alice@example.com' }, { to: 'bob@example.com' }]);
  });

  it('runs each batch in a fresh request scope (request-scoped deps rebuild per batch)', async () => {
    const seen: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class BatchContext {
      readonly id = crypto.randomUUID();
    }

    @Injectable()
    class ScopedWorker {
      constructor(private readonly ctx: BatchContext) {}

      @QueueConsumer('scoped-queue')
      async process(_batch: { messages: unknown[] }) {
        seen.push(this.ctx.id);
      }
    }

    @Module({ providers: [ScopedWorker, BatchContext] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env, envToken });
    const ctx = { waitUntil: () => {} };

    await app.queue({ queue: 'scoped-queue', messages: [{ body: 1 }] }, env, ctx);
    await app.queue({ queue: 'scoped-queue', messages: [{ body: 2 }] }, env, ctx);

    // Two batches → two distinct request-scoped BatchContext instances. The
    // old boot-instance dispatch could never do this (captive dependency).
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('runs consumer-scoped guards and interceptors through the pipeline', async () => {
    const events: string[] = [];

    class BlockGuard {
      canActivate(ctx: { getType: () => string }): boolean {
        events.push(`guard:${ctx.getType()}`);
        return false;
      }
    }

    class LogInterceptor {
      async intercept(_ctx: unknown, next: { handle: () => Promise<unknown> }) {
        events.push('intercept');
        return next.handle();
      }
    }

    @Injectable()
    class GuardedWorker {
      @UseGuards(new BlockGuard())
      @UseInterceptors(new LogInterceptor())
      @QueueConsumer('guarded-queue')
      async process(_batch: { messages: unknown[] }) {
        events.push('handled');
      }
    }

    @Module({ providers: [GuardedWorker] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env, envToken });
    const ctx = { waitUntil: () => {} };

    // Guard rejects → handler never runs; the rejection surfaces (platform
    // retry semantics) because no filter claims it.
    await expect(
      app.queue({ queue: 'guarded-queue', messages: [{ body: 1 }] }, env, ctx),
    ).rejects.toThrow();
    expect(events).toEqual(['guard:cf:queue']);
  });

  it('should not invoke consumers for non-matching queue', async () => {
    const processed: unknown[] = [];

    @Injectable()
    class Worker {
      @QueueConsumer('email-queue')
      async process(batch: { messages: unknown[] }) {
        processed.push('invoked');
      }
    }

    @Module({ providers: [Worker] })
    class AppModule {}

    const app = await createCloudflareApp(AppModule, { env, envToken });
    const ctx = { waitUntil: () => {} };

    await expect(
      app.queue({ queue: 'other-queue', messages: [{ body: 'test' }] }, env, ctx),
    ).rejects.toThrow('No consumer');

    expect(processed).toEqual([]);
  });
});
