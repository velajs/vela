// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { createExecutionContext, createMessageBatch, getQueueResult, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { observeMessage } from '@velajs/vela/queue';
import type { QueueJob } from '@velajs/vela/queue';
import { cloudflareQueueDriver, consumeQueueBatch } from '../../queue/cloudflare-queue';

function incoming(id: string) {
  return {
    id,
    timestamp: new Date(),
    attempts: 2,
    body: { id, queue: 'jobs', name: id, data: {}, attempt: 1 },
  };
}

describe('queue bridge under workerd', () => {
  it('honors native first settlement and retries only the explicit remainder', async () => {
    const batch = createMessageBatch('jobs', [incoming('retry'), incoming('ack')]);
    const ctx = createExecutionContext();
    await consumeQueueBatch(batch, async (job, message) => {
      if (job.name === 'retry') {
        const observed = observeMessage(message);
        observed.message.retry({ delaySeconds: 3 });
        observed.message.ack();
        expect(observed.disposition().outcome).toBe('retried');
        expect(observed.disposition().retryDelaySeconds).toBe(3);
      } else {
        message.ack();
        message.retry();
      }
    });
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['ack']);
    // cloudflare:test currently records retry identity but omits retry delays.
    expect(result.retryMessages.map((message: { msgId: string }) => message.msgId)).toEqual([
      'retry',
    ]);
  });

  it('leaves a failed message unsettled and acknowledges later successes', async () => {
    const batch = createMessageBatch('jobs', [incoming('bad'), incoming('ok')]);
    await expect(
      consumeQueueBatch(batch, async (job) => {
        if (job.name === 'bad') throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual(['ok']);
    expect(result.retryMessages).toEqual([]);
  });

  it('awaits acceptance by a real native queue producer binding', async () => {
    const queue: Queue<QueueJob> = env.QUEUE_BRIDGE;
    const driver = cloudflareQueueDriver({ jobs: queue });
    await expect(driver.enqueue(incoming('sent').body, { delayMs: 0 })).resolves.toBeUndefined();
  });
});
