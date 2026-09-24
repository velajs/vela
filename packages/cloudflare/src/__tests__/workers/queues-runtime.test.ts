// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
const { createExecutionContext, createMessageBatch, getQueueResult, env } = cloudflareTest;
import { describe, expect, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  APP_GUARD,
  Controller,
  Injectable,
  InjectEnv,
  Module,
  Post,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type VelaEnv,
} from '@velajs/vela';
import { SignedInvocation } from '@velajs/vela/dispatch';
import {
  dispatchQueueJob,
  InjectQueue,
  observeMessage,
  Process,
  Processor,
  QueueModule,
  type QueueClient,
  type QueueJob,
} from '@velajs/vela/queue';
import {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from '../../cloudflare-factory';
import { QueueConsumer } from '../../decorators/queue-consumer';
import { cloudflareQueues, consumeQueueBatch } from '../../queues';

function incoming(id: string, queue: string, name = id, data: unknown = {}) {
  return {
    id,
    timestamp: new Date(),
    attempts: 3,
    body: { id, queue, name, data, attempt: 1 },
  };
}

describe('QueueModule delivery under workerd', () => {
  it('routes jobs by logical queue and acknowledges only the settled messages', async () => {
    const seen: string[] = [];
    @Processor('email')
    class Email {
      constructor(@InjectEnv() private readonly bindings: VelaEnv) {}
      @Process() async handle(job: QueueJob<{ fail?: boolean }>) {
        seen.push(`email:${job.name}:${job.attempt}:${this.bindings.ENV_PROBE}`);
        if (job.data.fail) throw new Error('retry this job');
      }
    }
    @Processor('sms')
    class Sms {
      @Process() async handle(job: QueueJob) {
        seen.push(`sms:${job.name}`);
      }
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'QUEUE_BRIDGE' }),
        QueueModule.registerQueue({ name: 'sms' }),
      ],
      providers: [Email, Sms],
    })
    class App {}
    const worker = createCloudflareWorker({ module: App });
    const batch = createMessageBatch('shared-native', [
      incoming('welcome', 'email'),
      incoming('code', 'sms'),
      incoming('broken', 'email', 'broken', { fail: true }),
      incoming('orders', 'orders'),
      { id: 'raw', timestamp: new Date(), attempts: 1, body: 'not an envelope' },
    ]);
    const context = createExecutionContext();

    await expect(worker.queue(batch, env, context)).rejects.toBeInstanceOf(AggregateError);
    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual(['welcome', 'code']);
    expect(seen).toEqual(['email:welcome:3:workerd-env', 'sms:code', 'email:broken:3:workerd-env']);
  });

  it('runs the global guard through signed dispatch for native deliveries', async () => {
    const seen: string[] = [];
    class GlobalGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        seen.push(`guard:${context.getType()}`);
        return true;
      }
    }
    @Controller('/jobs')
    class JobsController {
      @Post('email')
      @SignedInvocation()
      email(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }
    @Processor('email')
    class Email {
      @Process() handle() {
        seen.push('direct');
      }
    }
    // The signing secret is the URL_SIGNING_SECRET variable wrangler.test.toml seeds into ENV.
    @Module({
      imports: [
        QueueModule.forRoot({
          driver: cloudflareQueues(),
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs/email' }) },
        }),
        QueueModule.registerQueue({ name: 'email', consumer: 'email-native' }),
      ],
      controllers: [JobsController],
      providers: [Email, defineProvider(APP_GUARD, { useClass: GlobalGuard })],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const batch = createMessageBatch('email-native', [incoming('signed', 'email')]);
    const context = createExecutionContext();

    await worker.queue(batch, env, context);
    expect(seen).toEqual(['guard:http', 'route']);
    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(['signed']);
  });

  it('reports each native delivery failure once', async () => {
    const reports: string[] = [];
    @Processor('email')
    class Email {
      @Process() handle(job: QueueJob) {
        if (job.name === 'fail') throw new Error('email failed');
      }
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email' }),
      ],
      providers: [
        Email,
        defineProvider(APP_EXCEPTION_HANDLER, {
          useValue: {
            report(error: unknown) {
              reports.push(error instanceof Error ? error.message : String(error));
            },
          },
        }),
      ],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const batch = createMessageBatch('reports-native', [
      incoming('ok', 'email'),
      incoming('fail', 'email'),
      incoming('placed', 'orders'),
      { id: 'raw', timestamp: new Date(), attempts: 1, body: 'not an envelope' },
    ]);
    const context = createExecutionContext();

    await expect(worker.queue(batch, env, context)).rejects.toBeInstanceOf(AggregateError);
    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(['ok']);
    expect(reports).toEqual([
      'email failed',
      expect.stringMatching(/'orders' is not registered/),
      expect.stringMatching(/Invalid queue job envelope/),
    ]);
  });

  it('keeps the global guard of signed dispatch in front of a custom transport', async () => {
    const seen: string[] = [];
    class Deny implements CanActivate {
      canActivate(): boolean {
        seen.push('guard');
        return false;
      }
    }
    @Controller('/jobs')
    class JobsController {
      @Post('guarded')
      @SignedInvocation()
      guarded(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }
    @Processor('guarded')
    class Guarded {
      @Process() handle() {
        seen.push('processor');
      }
    }
    @Module({
      imports: [
        QueueModule.forRoot({
          driver: cloudflareQueues(),
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs/guarded' }) },
        }),
        QueueModule.registerQueue({ name: 'guarded' }),
      ],
      controllers: [JobsController],
      providers: [Guarded, defineProvider(APP_GUARD, { useClass: Deny })],
    })
    class App {}
    const app = await VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })] });
    try {
      // A transport other than Cloudflare Queues hands each job to dispatchQueueJob.
      await expect(
        dispatchQueueJob(app.getContainer(), app.entrypoints, incoming('guarded', 'guarded').body),
      ).rejects.toThrow();
      expect(seen).toEqual(['guard']);
    } finally {
      await app.close();
    }
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

describe('cloudflareQueues() producers under workerd', () => {
  function producerApp() {
    @Injectable()
    class Producer {
      constructor(@InjectQueue('tasks') readonly tasks: QueueClient) {}
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'tasks', binding: 'QUEUE_BRIDGE' }),
      ],
      providers: [Producer],
    })
    class App {}
    return { App, Producer };
  }

  it('sends through the real producer binding read from ENV', async () => {
    const { App, Producer } = producerApp();
    const app = await createCloudflareApp(App, { env });
    const job = await app.get(Producer).tasks.add('run', { value: 1 }, { delayMs: 0 });
    expect(job.queue).toBe('tasks');
    await app.close();
  });

  it('chunks addBulk into native sendBatch calls within the platform limits', async () => {
    // The local producer accepts oversized calls, so count the calls the real binding receives.
    const queue: Queue = env.QUEUE_BRIDGE;
    const calls: number[] = [];
    const counted: VelaEnv = {
      ...env,
      QUEUE_BRIDGE: {
        send: (body: unknown, options?: QueueSendOptions) => queue.send(body, options),
        sendBatch: (messages: Iterable<MessageSendRequest>, options?: QueueSendBatchOptions) => {
          const list = [...messages];
          calls.push(list.length);
          return queue.sendBatch(list, options);
        },
        metrics: () => queue.metrics(),
      },
    };
    const { App, Producer } = producerApp();
    const app = await createCloudflareApp(App, { env: counted });
    const tasks = app.get(Producer).tasks;
    const added = await tasks.addBulk(
      Array.from({ length: 250 }, (_, index) => ({ job: 'small', data: { index } })),
    );
    expect(added).toHaveLength(250);
    expect(calls).toEqual([100, 100, 50]);
    await tasks.addBulk(
      Array.from({ length: 3 }, (_, index) => ({
        job: 'large',
        data: { index, text: 'x'.repeat(100_000) },
      })),
    );
    expect(calls).toEqual([100, 100, 50, 2, 1]);
    await app.close();
  });
});

describe('consumeQueueBatch under workerd', () => {
  it('honors native first settlement and retries only the explicit remainder', async () => {
    const batch = createMessageBatch('jobs', [incoming('retry', 'jobs'), incoming('ack', 'jobs')]);
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
    const batch = createMessageBatch('jobs', [incoming('bad', 'jobs'), incoming('ok', 'jobs')]);
    await expect(
      consumeQueueBatch(batch, async (job) => {
        if (job.name === 'bad') throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual(['ok']);
    expect(result.retryMessages).toEqual([]);
  });
});
