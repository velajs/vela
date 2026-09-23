// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { createExecutionContext, createMessageBatch, getQueueResult, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Cron, ENV, Injectable, Module, ScheduleModule } from '@velajs/vela';
import { Process, Processor, QueueModule, queueToken } from '@velajs/vela/queue';
import type { QueueJob } from '@velajs/vela/queue';
import { createCloudflareApp, createCloudflareWorker } from '../../cloudflare-factory';
import { cloudflareQueueDriver } from '../../queue';
import { QueueConsumer } from '../../decorators/queue-consumer';

describe('module dispatch in workerd', () => {
  it('boots on native delivery, preserves partial settlement and drives core cron handlers', async () => {
    let ticks = 0;
    const attempts: number[] = [];
    @Processor('tasks')
    @Injectable()
    class Tasks {
      @Process('run') async run(job: QueueJob<{ fail?: boolean }>) {
        attempts.push(job.attempt);
        if (job.data.fail) throw new Error('retry this job');
      }
      @Cron('* * * * *', { dialect: 'cloudflare' }) async tick() {
        ticks++;
      }
    }
    @Module({
      imports: [
        ScheduleModule.forRoot(),
        QueueModule.forRootAsync({
          queues: ['tasks'],
          inject: [ENV],
          useFactory: (bindings) => ({
            driver: cloudflareQueueDriver(
              { tasks: bindings.QUEUE_BRIDGE },
              { consumers: { 'native-tasks': 'tasks' } },
            ),
          }),
        }),
      ],
      providers: [Tasks],
    })
    class App {}
    const worker = createCloudflareWorker({ create: async () => ({ module: App }) });
    const batch = createMessageBatch(
      'native-tasks',
      [false, true].map((fail, index) => ({
        id: String(index),
        timestamp: new Date(),
        attempts: 3,
        body: { id: String(index), queue: 'tasks', name: 'run', data: { fail }, attempt: 1 },
      })),
    );
    const context = createExecutionContext();
    await expect(worker.queue(batch, env, context)).rejects.toThrow('retry this job');
    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(['0']);
    expect(attempts).toEqual([3, 3]);
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now() },
      env,
      createExecutionContext(),
    );
    expect(ticks).toBe(1);
    const app = await createCloudflareApp(App, { env });
    await app.get(queueToken('tasks')).add('run', {});
    await app.close();
  });

  it('rejects an unclaimed native batch without acknowledging any message', async () => {
    const handled: string[] = [];
    @Injectable()
    class Claimed {
      @QueueConsumer('claimed-native')
      async consume(batch: { messages: readonly unknown[] }) {
        handled.push(`batch:${batch.messages.length}`);
      }
    }
    @Module({ providers: [Claimed] })
    class App {}
    const worker = createCloudflareWorker(App);
    const batch = createMessageBatch('unclaimed-native', [
      { id: 'lost-0', timestamp: new Date(), attempts: 1, body: { value: 1 } },
    ]);
    const context = createExecutionContext();

    await expect(worker.queue(batch, env, context)).rejects.toThrow(
      /No consumer claims queue 'unclaimed-native'/,
    );
    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual([]);
    expect(handled).toEqual([]);
  });
});
