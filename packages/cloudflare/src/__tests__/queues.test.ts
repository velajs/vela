import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_LIFETIME,
  Inject,
  Injectable,
  InjectEnv,
  Module,
  Scope,
  VelaFactory,
  type ExecutionLifetime,
  type VelaEnv,
} from '@velajs/vela';
import {
  InjectQueue,
  Process,
  Processor,
  QueueBatchError,
  QueueModule,
  queueToken,
  type QueueClient,
  type QueueJob,
  type QueueMessageLike,
} from '@velajs/vela/queue';
import {
  cloudflareAdapter,
  createCloudflareApp,
  createCloudflareWorker,
} from '../cloudflare-factory';
import { QueueConsumer } from '../decorators/queue-consumer';
import { cloudflareQueues, consumeQueueBatch } from '../queues';
import { QUEUE_SEND_LIMITS, estimateQueueMessageBytes } from '../queue/cloudflare-queues';

const context = { waitUntil() {} };

function envelope(queue: string, name = 'run', data: unknown = {}, id = crypto.randomUUID()) {
  return { id, queue, name, data, attempt: 1 };
}
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

type Sent = { body: QueueJob; delaySeconds?: number };
/** A producer binding that records every native call. */
function producer() {
  const sends: Sent[] = [];
  const batches: Sent[][] = [];
  return {
    sends,
    batches,
    send: vi.fn(async (body: QueueJob, options?: QueueSendOptions) => {
      sends.push({ body, ...(options?.delaySeconds === undefined ? {} : options) });
    }),
    sendBatch: vi.fn(async (messages: Iterable<MessageSendRequest<QueueJob>>) => {
      batches.push(
        [...messages].map(({ body, delaySeconds }) => ({
          body,
          ...(delaySeconds === undefined ? {} : { delaySeconds }),
        })),
      );
    }),
  };
}

function processors() {
  const seen: string[] = [];
  @Processor('email')
  @Injectable()
  class Email {
    @Process() handle(job: QueueJob) {
      seen.push(`email:${job.name}:${job.attempt}`);
      if (job.name === 'fail') throw new Error('email failed');
    }
  }
  @Processor('sms')
  @Injectable()
  class Sms {
    @Process() handle(job: QueueJob) {
      seen.push(`sms:${job.name}`);
    }
  }
  return { seen, providers: [Email, Sms] };
}

describe('cloudflareQueues() producers', () => {
  it('reads the registered binding from each application ENV when a job is added', async () => {
    const reads: string[] = [];
    const a = producer();
    const b = producer();
    const environment = (name: string, queue: ReturnType<typeof producer>): VelaEnv =>
      Object.defineProperty({ NAME: name }, 'EMAIL_QUEUE', {
        get() {
          reads.push(name);
          return queue;
        },
      });
    @Injectable()
    class Signup {
      constructor(@InjectQueue('email') readonly email: QueueClient) {}
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
      ],
      providers: [Signup],
    })
    class App {}

    const first = await createCloudflareApp(App, { env: environment('a', a) });
    const second = await createCloudflareApp(App, { env: environment('b', b) });
    expect(reads).toEqual([]);
    const job = await first.get(Signup).email.add('welcome', { user: 1 }, { delayMs: 1001 });
    await second.get(Signup).email.add('welcome', { user: 2 });
    expect(reads).toEqual(['a', 'b']);
    expect(a.sends).toEqual([{ body: job, delaySeconds: 2 }]);
    expect(b.sends.map((sent) => sent.body.data)).toEqual([{ user: 2 }]);
    await first.close();
    await second.close();
  });

  it('awaits the native send and surfaces its failure', async () => {
    let release!: () => void;
    const queue = producer();
    queue.send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
      ],
    })
    class App {}
    const app = await createCloudflareApp(App, { env: { EMAIL_QUEUE: queue } });
    const client = app.get(queueToken('email'));
    let accepted = false;
    const pending = client.add('n', {}).then(() => {
      accepted = true;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    release();
    await pending;
    queue.send.mockRejectedValueOnce(new Error('send failed'));
    await expect(client.add('n', {})).rejects.toThrow('send failed');
    await expect(client.add('n', {}, { delayMs: Number.NaN })).rejects.toThrow('delayMs');
    await app.close();
  });

  it('explains a missing, wrong or undeclared producer binding', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
        QueueModule.registerQueue({ name: 'inbound', consumer: 'inbound-production' }),
      ],
    })
    class App {}
    const missing = await createCloudflareApp(App, { env: {} });
    await expect(missing.get(queueToken('email')).add('n', {})).rejects.toThrow(
      /ENV\.EMAIL_QUEUE is not a Cloudflare queue producer/,
    );
    await expect(missing.get(queueToken('inbound')).add('n', {})).rejects.toThrow(
      /Queue 'inbound' has no producer binding/,
    );
    const wrong = await createCloudflareApp(App, { env: { EMAIL_QUEUE: { send: 'no' } } });
    await expect(wrong.get(queueToken('email')).add('n', {})).rejects.toThrow(/not a Cloudflare/);
    await missing.close();
    await wrong.close();
  });

  it('requires the Workers ENV', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    await expect(app.get(queueToken('email')).add('n', {})).rejects.toThrow(/ENV/);
    await app.close();
  });
});

describe('cloudflareQueues() addBulk', () => {
  async function bulkApp(queue: object) {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
      ],
    })
    class App {}
    const app = await createCloudflareApp(App, { env: { EMAIL_QUEUE: queue } });
    return { app, client: app.get(queueToken('email')) };
  }
  const jobs = (count: number, data: (index: number) => unknown = (index) => ({ index })) =>
    Array.from({ length: count }, (_, index) => ({ job: 'n', data: data(index) }));

  it('sends at most 100 messages per native call', async () => {
    const queue = producer();
    const { app, client } = await bulkApp(queue);
    expect(QUEUE_SEND_LIMITS.messages).toBe(100);
    await client.addBulk(jobs(100));
    expect(queue.batches.map((batch) => batch.length)).toEqual([100]);
    const added = await client.addBulk(jobs(101));
    expect(queue.batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
    expect(
      queue.batches
        .slice(1)
        .flat()
        .map((sent) => sent.body.id),
    ).toEqual(added.map((job) => job.id));
    expect(queue.send).not.toHaveBeenCalled();
    await app.close();
  });

  it('splits by the estimated byte budget and keeps each call within it', async () => {
    const queue = producer();
    const { app, client } = await bulkApp(queue);
    // Three messages whose estimates fill the budget exactly fit one call.
    const base = estimateQueueMessageBytes(envelope('email', 'n', { text: '' }));
    const third = Math.floor(QUEUE_SEND_LIMITS.batchBytes / 3);
    const fill = (extra: number) => ({ text: 'x'.repeat(third - base + extra) });
    const exact = [fill(0), fill(0), fill(QUEUE_SEND_LIMITS.batchBytes - 3 * third)];
    const bodies = exact.map((data) => ({ ...envelope('email', 'n', data) }));
    expect(bodies.reduce((sum, body) => sum + estimateQueueMessageBytes(body), 0)).toBe(
      QUEUE_SEND_LIMITS.batchBytes,
    );
    await client.addBulk(exact.map((data) => ({ job: 'n', data })));
    expect(queue.batches.map((batch) => batch.length)).toEqual([3]);
    // One more byte starts a second call.
    await client.addBulk(
      [fill(0), fill(0), fill(QUEUE_SEND_LIMITS.batchBytes - 3 * third + 1)].map((data) => ({
        job: 'n',
        data,
      })),
    );
    expect(queue.batches.map((batch) => batch.length)).toEqual([3, 2, 1]);
    for (const batch of queue.batches) {
      const bytes = batch.reduce((sum, sent) => sum + estimateQueueMessageBytes(sent.body), 0);
      expect(bytes).toBeLessThanOrEqual(QUEUE_SEND_LIMITS.batchBytes);
    }
    await app.close();
  });

  it('rejects a message over the per-message limit before sending anything', async () => {
    const queue = producer();
    const { app, client } = await bulkApp(queue);
    const oversized = 'x'.repeat(QUEUE_SEND_LIMITS.messageBytes);
    await expect(
      client.addBulk([
        { job: 'n', data: { text: 'small' } },
        { job: 'n', data: { text: oversized } },
      ]),
    ).rejects.toThrow(/over the 128000-byte Cloudflare message limit/);
    expect(queue.batches).toEqual([]);
    // Two-byte strings are measured as V8 stores them, not as UTF-8.
    const wide = '一'.repeat(QUEUE_SEND_LIMITS.messageBytes / 2);
    expect(estimateQueueMessageBytes({ text: wide })).toBeGreaterThan(
      QUEUE_SEND_LIMITS.messageBytes,
    );
    await app.close();
  });

  it('maps per-job delays and rejects a partial send with the accepted job ids', async () => {
    const queue = producer();
    const record = queue.sendBatch.getMockImplementation()!;
    queue.sendBatch.mockImplementationOnce(record);
    queue.sendBatch.mockRejectedValueOnce(new Error('queue unavailable'));
    const { app, client } = await bulkApp(queue);
    const failure: unknown = await client
      .addBulk(
        Array.from({ length: 150 }, (_, index) => ({
          job: 'n',
          data: index,
          options: { delayMs: index === 0 ? 1500 : 0 },
        })),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueueBatchError);
    const error = failure as QueueBatchError;
    const sentIds = queue.batches.flat().map((sent) => sent.body.id);
    expect(error.accepted).toEqual(sentIds);
    expect(error.accepted).toHaveLength(100);
    expect(error.rejected).toHaveLength(50);
    expect(error.message).toContain(sentIds[99]);
    expect(queue.batches[0]![0]!.delaySeconds).toBe(2);
    expect(queue.batches[0]![1]!.delaySeconds).toBe(0);
    await app.close();
  });

  it('falls back to single sends on a binding without sendBatch', async () => {
    const queue = producer();
    const { app, client } = await bulkApp({ send: queue.send });
    queue.send.mockImplementation(async (body: QueueJob) => {
      if (body.data === 2) throw new Error('rejected');
      queue.sends.push({ body });
    });
    const failure = (await client
      .addBulk(jobs(4, (index) => index))
      .catch((e: unknown) => e)) as QueueBatchError;
    expect(failure.accepted).toEqual(queue.sends.map((sent) => sent.body.id));
    expect(failure.accepted).toHaveLength(2);
    expect(failure.rejected).toHaveLength(2);
    await app.close();
  });
});

describe('cloudflareQueues() native delivery', () => {
  function app() {
    const { seen, providers } = processors();
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
        QueueModule.registerQueue({ name: 'sms' }),
      ],
      providers,
    })
    class App {}
    return { App, seen };
  }

  it('routes several logical queues that share one physical queue by the envelope', async () => {
    const { App, seen } = app();
    const worker = createCloudflareWorker(App);
    const messages = [
      message(envelope('email', 'welcome')),
      message(envelope('sms', 'code')),
      message(envelope('email', 'digest'), 4),
    ];
    await worker.queue({ queue: 'shared-production', messages }, {}, context);
    expect(seen).toEqual(['email:welcome:2', 'sms:code', 'email:digest:4']);
    for (const item of messages) expect(item.ack).toHaveBeenCalledOnce();
  });

  it('acknowledges successes and leaves unknown, raw and failed messages for retry', async () => {
    const { App, seen } = app();
    const worker = createCloudflareWorker(App);
    const ok = message(envelope('sms', 'ok'));
    const unknown = message(envelope('orders', 'placed'));
    const raw = message({ plain: 'payload' });
    const failed = message(envelope('email', 'fail'));
    const last = message(envelope('email', 'last'));
    await expect(
      worker.queue(
        { queue: 'shared-production', messages: [ok, unknown, raw, failed, last] },
        {},
        context,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(seen).toEqual(['sms:ok', 'email:fail:2', 'email:last:2']);
    expect([ok, unknown, raw, failed, last].map((item) => item.ack.mock.calls.length)).toEqual([
      1, 0, 0, 0, 1,
    ]);
    const single = message(envelope('orders', 'placed'));
    await expect(
      worker.queue({ queue: 'shared-production', messages: [single] }, {}, context),
    ).rejects.toThrow(/Queue 'orders' is not registered/);
  });

  it('only accepts the queues pinned to a physical queue by an explicit consumer', async () => {
    const { seen, providers } = processors();
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', consumer: 'email-production' }),
        QueueModule.registerQueue({ name: 'sms' }),
      ],
      providers,
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const email = message(envelope('email', 'pinned'));
    const sms = message(envelope('sms', 'misrouted'));
    await expect(
      worker.queue({ queue: 'email-production', messages: [email, sms] }, {}, context),
    ).rejects.toThrow(/'sms' .*'email-production'/);
    expect(email.ack).toHaveBeenCalledOnce();
    expect(sms.ack).not.toHaveBeenCalled();
    // Unpinned physical queues still route by the envelope, except for the
    // pinned queue: its jobs must arrive from the physical queue it names.
    const free = message(envelope('sms', 'free'));
    const stray = message(envelope('email', 'stray'));
    await expect(
      worker.queue({ queue: 'other-production', messages: [free, stray] }, {}, context),
    ).rejects.toThrow(/'email' is consumed from 'email-production', not 'other-production'/);
    expect(free.ack).toHaveBeenCalledOnce();
    expect(stray.ack).not.toHaveBeenCalled();
    expect(seen).toEqual(['email:pinned:2', 'sms:free']);
  });

  it('runs every processor in a fresh scope with the delivering environment', async () => {
    const seen: { env: string; scope: string }[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      readonly id = crypto.randomUUID();
    }
    @Processor('tasks')
    @Injectable()
    class Tasks {
      constructor(
        @InjectEnv() private env: { NAME: string },
        private resource: Resource,
        @Inject(EXECUTION_LIFETIME) private lifetime: ExecutionLifetime,
      ) {}
      @Process('run') async run(job: QueueJob<{ deferredFail?: boolean }>) {
        seen.push({ env: this.env.NAME, scope: this.resource.id });
        if (job.data.deferredFail) {
          this.lifetime.waitUntil(Promise.reject(new Error('deferred failed')));
        }
      }
    }
    @Module({
      imports: [
        QueueModule.forRootAsync({
          inject: [],
          useFactory: async () => ({ driver: cloudflareQueues() }),
        }),
        QueueModule.registerQueue({ name: 'tasks' }),
      ],
      providers: [Tasks, Resource],
    })
    class App {}
    const worker = createCloudflareWorker(App);
    const a = message(envelope('tasks'));
    const b = message(envelope('tasks'));
    await Promise.all([
      worker.queue({ queue: 'tasks-physical', messages: [a] }, { NAME: 'a' }, context),
      worker.queue({ queue: 'tasks-physical', messages: [b] }, { NAME: 'b' }, context),
    ]);
    expect(seen.map((entry) => entry.env).toSorted()).toEqual(['a', 'b']);
    expect(new Set(seen.map((entry) => entry.scope)).size).toBe(2);
    const deferred = message(envelope('tasks', 'run', { deferredFail: true }));
    await expect(
      worker.queue({ queue: 'tasks-physical', messages: [deferred] }, { NAME: 'a' }, context),
    ).rejects.toThrow('deferred failed');
    expect(deferred.ack).not.toHaveBeenCalled();
  });

  it('gives raw @QueueConsumer handlers their physical queue', async () => {
    const batches: string[] = [];
    @Injectable()
    class Native {
      @QueueConsumer('raw-production') async consume(batch: { queue: string }) {
        batches.push(batch.queue);
      }
    }
    const { App, seen } = app();
    @Module({ imports: [App], providers: [Native] })
    class Root {}
    const worker = createCloudflareWorker(Root);
    const raw = message({ plain: true });
    await worker.queue({ queue: 'raw-production', messages: [raw] }, {}, context);
    expect(batches).toEqual(['raw-production']);
    expect(seen).toEqual([]);
  });

  it('rejects a physical queue claimed by a raw consumer and an explicit module consumer', async () => {
    @Injectable()
    class Native {
      @QueueConsumer('email-production') async consume() {}
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', consumer: 'email-production' }),
      ],
      providers: [Native],
    })
    class App {}
    await expect(createCloudflareApp(App, { env: {} })).rejects.toThrow(
      /Ambiguous consumer ownership for queue 'email-production'/,
    );
    await expect(
      VelaFactory.create(App, { adapters: [cloudflareAdapter({ env: {} })] }),
    ).rejects.toThrow(/Ambiguous consumer ownership/);
  });

  it('publishes one native module route with the pinned physical queues', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: cloudflareQueues() }),
        QueueModule.registerQueue({ name: 'email', consumer: 'email-production' }),
        QueueModule.registerQueue({ name: 'sms', consumer: 'email-production' }),
        QueueModule.registerQueue({ name: 'push', binding: 'PUSH_QUEUE' }),
      ],
    })
    class App {}
    const application = await createCloudflareApp(App, { env: {} });
    expect(application.entrypoints.ofKind('cf:queue:module').map((entry) => entry.meta)).toEqual([
      { consumers: ['email-production'] },
    ]);
    await application.close();
  });
});

describe('consumeQueueBatch', () => {
  const job = (name = 'ok'): QueueJob => ({
    id: name,
    queue: 'logical',
    name,
    data: {},
    attempt: 1,
  });

  it('settles successful messages, tries later messages, and rejects the failed remainder', async () => {
    const messages = [message(job()), message(job('bad')), message(job('last'))];
    const seen: string[] = [];
    await expect(
      consumeQueueBatch({ queue: 'physical', messages }, async (received) => {
        expect(received.attempt).toBe(2);
        seen.push(received.name);
        if (received.name === 'bad') throw new Error('failure');
        return { handled: 1 };
      }),
    ).rejects.toThrow('failure');
    expect(seen).toEqual(['ok', 'bad', 'last']);
    expect(messages.map((m) => m.ack.mock.calls.length)).toEqual([1, 0, 1]);
  });

  it('retains explicit retry and refuses unknown, unhandled or unaccepted envelopes', async () => {
    const retried = message(job());
    await consumeQueueBatch({ queue: 'physical', messages: [retried] }, async (_job, host) => {
      host.retry({ delaySeconds: 4 });
    });
    expect(retried.ack).not.toHaveBeenCalled();
    expect(retried.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
    const invalid = message({ data: {} });
    const foreign = message({ ...job(), queue: 'foreign' });
    const missing = message(job());
    const dispatch = vi.fn(async () => ({ handled: 0 }));
    await expect(
      consumeQueueBatch({ queue: 'physical', messages: [invalid, foreign, missing] }, dispatch, {
        queues: ['logical'],
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    for (const host of [invalid, foreign, missing]) expect(host.ack).not.toHaveBeenCalled();
  });

  it('does not trust the producer attempt', async () => {
    await consumeQueueBatch(
      { queue: 'physical', messages: [message({ ...job(), attempt: 'spoofed' }, 3)] },
      async (received) => {
        expect(received.attempt).toBe(3);
      },
    );
  });
});

describe('async dynamic Worker roots', () => {
  it('shares cold factory work, evicts failures, and keeps dynamic providers', async () => {
    let calls = 0;
    const { providers } = processors();
    @Module({})
    class Root {}
    const worker = createCloudflareWorker({
      async create() {
        calls++;
        await Promise.resolve();
        if (calls === 1) throw new Error('retry bootstrap');
        return {
          module: Root,
          imports: [
            QueueModule.forRoot({ driver: cloudflareQueues() }),
            QueueModule.registerQueue({ name: 'sms' }),
          ],
          providers,
        };
      },
    });
    const env = { NAME: 'same' };
    const first = () =>
      worker.queue(
        { queue: 'sms-physical', messages: [message(envelope('sms', 'cold'))] },
        env,
        context,
      );
    const results = await Promise.allSettled([first(), first()]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
    await Promise.all([first(), first()]);
    expect(calls).toBe(2);
  });
});
