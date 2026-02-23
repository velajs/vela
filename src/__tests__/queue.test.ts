import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
} from '@velajs/vela';
import { CloudflareFactory } from '../cloudflare-factory';
import { QueueModule } from '../modules/queue.module';
import { QueueService } from '../services/queue.service';
import { QueueConsumer } from '../decorators/queue-consumer';
import { clearBindingsRegistry } from '../tokens';

beforeEach(() => {
  MetadataRegistry.clear();
  clearBindingsRegistry();
});

function createMockQueue() {
  const messages: unknown[] = [];
  return {
    send: async (message: unknown) => {
      messages.push(message);
    },
    sendBatch: async (batch: Iterable<{ body: unknown }>) => {
      for (const msg of batch) messages.push(msg.body);
    },
    _messages: messages,
  };
}

describe('QueueModule', () => {
  it('should inject QueueService for producing messages', async () => {
    const mockQueue = createMockQueue();

    @Controller('/jobs')
    class JobController {
      constructor(private queue: QueueService) {}

      @Get('/send')
      async sendJob() {
        await this.queue.send({ type: 'email', to: 'alice@example.com' });
        return { queued: true };
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ binding: 'JOB_QUEUE' })],
      controllers: [JobController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/jobs/send', undefined, { JOB_QUEUE: mockQueue });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    expect(mockQueue._messages).toEqual([{ type: 'email', to: 'alice@example.com' }]);
  });

  it('should support sendBatch', async () => {
    const mockQueue = createMockQueue();

    @Controller('/jobs')
    class JobController {
      constructor(private queue: QueueService) {}

      @Get('/batch')
      async sendBatch() {
        await this.queue.sendBatch([
          { body: 'msg1' },
          { body: 'msg2' },
          { body: 'msg3' },
        ]);
        return { count: 3 };
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ binding: 'Q' })],
      controllers: [JobController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/jobs/batch', undefined, { Q: mockQueue });
    expect(res.status).toBe(200);
    expect(mockQueue._messages).toEqual(['msg1', 'msg2', 'msg3']);
  });
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

    const app = await CloudflareFactory.create(AppModule);
    const ctx = { waitUntil: () => {} };

    await app.queue(
      {
        queue: 'email-queue',
        messages: [
          { body: { to: 'alice@example.com' } },
          { body: { to: 'bob@example.com' } },
        ],
      },
      {},
      ctx,
    );

    expect(processed).toEqual([
      { to: 'alice@example.com' },
      { to: 'bob@example.com' },
    ]);
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

    const app = await CloudflareFactory.create(AppModule);
    const ctx = { waitUntil: () => {} };

    await app.queue(
      { queue: 'other-queue', messages: [{ body: 'test' }] },
      {},
      ctx,
    );

    expect(processed).toEqual([]);
  });
});
