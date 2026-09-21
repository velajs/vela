import { describe, expect, it, vi } from 'vitest';
import { cloudflareQueueDriver, consumeQueueBatch } from '../queue/cloudflare-queue';
import type { QueueJob, QueueMessageLike } from '@velajs/vela/queue';
import {
  Container,
  EntrypointRegistry,
  Inject,
  Injectable,
  InjectionToken,
  Module,
} from '@velajs/vela';
import { dispatchQueueJob, Process, Processor } from '@velajs/vela/queue';
import { QueueConsumer } from '../decorators/queue-consumer';
import { createCloudflareApp } from '../cloudflare-factory';

const job = (name = 'ok'): QueueJob => ({ id: name, queue: 'logical', name, data: {}, attempt: 1 });
function message(body: unknown, attempts = 2) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies QueueMessageLike;
}

describe('portable Cloudflare queue bridge', () => {
  it('awaits native send, maps delay and surfaces rejection without retry', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await barrier;
    });
    const driver = cloudflareQueueDriver({ logical: { send } });
    let accepted = false;
    const pending = driver.enqueue(job(), { delayMs: 1001 }).then(() => {
      accepted = true;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    release();
    await pending;
    expect(send).toHaveBeenCalledWith(job(), { delaySeconds: 2 });
    await driver.enqueue(job(), { delayMs: 0 });
    expect(send).toHaveBeenLastCalledWith(job(), { delaySeconds: 0 });
    send.mockRejectedValueOnce(new Error('send failed'));
    await expect(driver.enqueue(job())).rejects.toThrow('send failed');
    expect(send).toHaveBeenCalledTimes(3);
    await expect(driver.enqueue({ ...job(), queue: 'missing' })).rejects.toThrow(
      'No Cloudflare producer',
    );
    await expect(driver.enqueue(job(), { delayMs: NaN })).rejects.toThrow('delayMs');
  });

  it('settles successful messages, tries later messages, and rejects the failed remainder', async () => {
    const messages = [message(job()), message(job('bad')), message(job('last'))];
    const seen: string[] = [];
    await expect(
      consumeQueueBatch(
        { queue: 'physical', messages },
        async (received) => {
          expect(received.attempt).toBe(2);
          seen.push(received.name);
          if (received.name === 'bad') throw new Error('failure');
          return { handled: 1 };
        },
        { queue: 'logical' },
      ),
    ).rejects.toThrow('failure');
    expect(seen).toEqual(['ok', 'bad', 'last']);
    expect(messages.map((m) => m.ack.mock.calls.length)).toEqual([1, 0, 1]);
  });

  it('retains explicit retry and refuses unknown or mismatched envelopes', async () => {
    const retried = message(job());
    await consumeQueueBatch({ queue: 'logical', messages: [retried] }, async (_job, host) => {
      host.retry({ delaySeconds: 4 });
    });
    expect(retried.ack).not.toHaveBeenCalled();
    expect(retried.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
    const invalid = message({ data: {} });
    const mismatch = message({ ...job(), queue: 'foreign' });
    const missing = message(job());
    const dispatch = vi.fn(async () => ({ handled: 0 }));
    await expect(
      consumeQueueBatch({ queue: 'logical', messages: [invalid, mismatch, missing] }, dispatch),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    for (const host of [invalid, mismatch, missing]) expect(host.ack).not.toHaveBeenCalled();
  });

  it('does not trust the producer attempt and keeps application bindings separate', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    await cloudflareQueueDriver({ logical: { send: a } }).enqueue(job());
    await cloudflareQueueDriver({ logical: { send: b } }).enqueue(job());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await consumeQueueBatch(
      { queue: 'logical', messages: [message({ ...job(), attempt: 'spoofed' }, 3)] },
      async (received) => {
        expect(received.attempt).toBe(3);
      },
    );
  });
});

it('composes native consumers with the portable registry after bootstrap', async () => {
  const seen: number[] = [];
  @Processor('logical')
  @Injectable()
  class ProcessorService {
    @Process('ok') handle(job: QueueJob) {
      seen.push(job.attempt);
    }
  }
  @Injectable()
  class ConsumerService {
    constructor(@Inject(Container) private readonly container: Container) {}
    @QueueConsumer('physical')
    async consume(batch: { queue: string; messages: QueueMessageLike[] }) {
      await consumeQueueBatch(
        batch,
        (job) =>
          dispatchQueueJob(this.container, this.container.resolve(EntrypointRegistry), job, {
            unhandled: 'error',
          }),
        { queue: 'logical' },
      );
    }
  }
  @Module({ providers: [ConsumerService, ProcessorService] })
  class App {}
  const env = {};
  const app = await createCloudflareApp(App, {
    env,
    envToken: new InjectionToken<object>('bridge env'),
  });
  const host = message(job(), 4);
  await app.queue({ queue: 'physical', messages: [host] }, env, { waitUntil() {} });
  expect(seen).toEqual([4]);
  expect(host.ack).toHaveBeenCalledTimes(1);
  await app.close();
});
