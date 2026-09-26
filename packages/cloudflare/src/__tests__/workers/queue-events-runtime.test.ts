// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
const { createExecutionContext, createMessageBatch, getQueueResult, env } = cloudflareTest;
import { describe, expect, it } from 'vitest';
import { Controller, Injectable, InjectEnv, Module, Post, Scope, type VelaEnv } from '@velajs/vela';
import { SignedInvocation } from '@velajs/vela/dispatch';
import { QueueModule } from '@velajs/vela/queue';
import { createCloudflareWorker } from '../../cloudflare-factory';
import { QueueConsumer } from '../../decorators/queue-consumer';
import { cloudflareQueues } from '../../queues';
import { consumeQueueEvents, defineQueueEvent } from '../../queue-events';
import {
  buildEventExpectation,
  eventConsumerExpectation,
  workerBuildSucceeded,
} from '../fixtures/worker-build-event';

function incoming(id: string, body: unknown = workerBuildSucceeded()) {
  return { id, timestamp: new Date(), attempts: 2, body };
}

describe('platform event subscriptions under workerd', () => {
  it('uses native per-message settlement after async handlers and preserves duplicate deliveries', async () => {
    const seen: string[] = [];
    @Injectable()
    class Events {
      @QueueConsumer('platform-events')
      consume(batch: MessageBatch<unknown>) {
        return consumeQueueEvents(batch, {
          ...eventConsumerExpectation,
          handlers: [
            defineQueueEvent({
              ...buildEventExpectation,
              async handle(event, delivery) {
                await Promise.resolve();
                seen.push(`${delivery.messageId}:${event.payload.buildUuid}`);
                if (delivery.messageId === 'failed') throw new Error('handler failed');
              },
            }),
          ],
        });
      }
    }
    @Module({ providers: [Events] })
    class App {}
    const worker = createCloudflareWorker(App);
    const future = workerBuildSucceeded();
    future.metadata.eventSchemaVersion = 2;
    const unknown = workerBuildSucceeded();
    unknown.type = 'cf.workersBuilds.worker.build.unknown';
    const batch = createMessageBatch('platform-events', [
      incoming('ok'),
      incoming('bad', null),
      incoming('future', future),
      incoming('unknown', unknown),
      incoming('failed'),
      incoming('duplicate'),
    ]);
    const context = createExecutionContext();
    await expect(worker.queue(batch, env, context)).rejects.toThrow();
    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual(['ok', 'duplicate']);
    expect(result.retryMessages.map((message: { msgId: string }) => message.msgId)).toEqual([
      'bad',
      'future',
      'unknown',
      'failed',
    ]);
    expect(seen).toEqual(
      ['ok', 'failed', 'duplicate'].map(
        (id) => `${id}:${workerBuildSucceeded().payload.buildUuid}`,
      ),
    );
  });

  it('isolates platform events from the signed QueueModule dispatch path in both directions', async () => {
    const calls: string[] = [];
    @Injectable()
    class Events {
      @QueueConsumer('platform-events')
      consume(batch: MessageBatch<unknown>) {
        return consumeQueueEvents(batch, {
          ...eventConsumerExpectation,
          handlers: [
            defineQueueEvent({
              ...buildEventExpectation,
              handle() {
                calls.push('platform');
              },
            }),
          ],
        });
      }
    }
    @Controller('/jobs')
    class Jobs {
      @Post('run')
      @SignedInvocation()
      run() {
        calls.push('signed');
        return { ok: true };
      }
    }
    @Module({
      imports: [
        QueueModule.forRoot({
          driver: cloudflareQueues(),
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs/run' }) },
        }),
        QueueModule.forFeature([{ name: 'jobs', consumer: 'signed-jobs' }]),
      ],
      providers: [Events],
      controllers: [Jobs],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const job = { id: 'job-1', queue: 'jobs', name: 'run', data: {}, attempt: 1 };
    const platforms = createMessageBatch('platform-events', [
      incoming('event'),
      incoming('misplaced-job', job),
    ]);
    const platformContext = createExecutionContext();
    await expect(worker.queue(platforms, env, platformContext)).rejects.toThrow();
    const platformResult = await getQueueResult(platforms, platformContext);
    expect(platformResult.explicitAcks).toEqual(['event']);
    expect(platformResult.retryMessages.map((message: { msgId: string }) => message.msgId)).toEqual(
      ['misplaced-job'],
    );
    expect(calls).toEqual(['platform']);

    const jobs = createMessageBatch('signed-jobs', [
      incoming('job', job),
      incoming('misplaced-event'),
    ]);
    const jobContext = createExecutionContext();
    await expect(worker.queue(jobs, env, jobContext)).rejects.toThrow();
    expect((await getQueueResult(jobs, jobContext)).explicitAcks).toEqual(['job']);
    expect(calls).toEqual(['platform', 'signed']);
  });

  it('keeps environment expectations and request-scoped provider state separate across concurrent batches', async () => {
    const seen: { environment: string; count: number }[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Events {
      private count = 0;
      constructor(@InjectEnv() private readonly bindings: VelaEnv) {}
      @QueueConsumer('platform-events')
      consume(batch: MessageBatch<unknown>) {
        return consumeQueueEvents(batch, {
          ...eventConsumerExpectation,
          accountId: this.bindings.ENV_PROBE,
          handlers: [
            defineQueueEvent({
              ...buildEventExpectation,
              handle: async () => {
                await Promise.resolve();
                seen.push({ environment: this.bindings.ENV_PROBE, count: ++this.count });
              },
            }),
          ],
        });
      }
    }
    @Module({ providers: [Events] })
    class App {}
    const worker = createCloudflareWorker(App);
    const first: VelaEnv = { ...env, ENV_PROBE: 'account-a' };
    const second: VelaEnv = { ...env, ENV_PROBE: 'account-b' };
    await Promise.all(
      [first, second, first].map(async (bindings, index) => {
        const event = workerBuildSucceeded();
        event.metadata.accountId = bindings.ENV_PROBE;
        const batch = createMessageBatch('platform-events', [incoming(`message-${index}`, event)]);
        const context = createExecutionContext();
        await worker.queue(batch, bindings, context);
        expect((await getQueueResult(batch, context)).explicitAcks).toEqual([`message-${index}`]);
      }),
    );
    expect(seen).toHaveLength(3);
    expect(seen.every(({ count }) => count === 1)).toBe(true);
    expect(seen.filter(({ environment }) => environment === 'account-a')).toHaveLength(2);
    expect(seen.filter(({ environment }) => environment === 'account-b')).toHaveLength(1);
    const misplaced = createMessageBatch('platform-events', [incoming('wrong-account')]);
    const context = createExecutionContext();
    await expect(worker.queue(misplaced, first, context)).rejects.toThrow();
    expect((await getQueueResult(misplaced, context)).explicitAcks).toEqual([]);
    expect(seen).toHaveLength(3);
  });
});
