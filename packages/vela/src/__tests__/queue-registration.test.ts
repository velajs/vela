import { describe, expect, it, vi } from 'vitest';
import {
  Controller,
  Global,
  Injectable,
  Module,
  Post,
  SignedInvocation,
  URL_SIGNING_SECRET,
  VelaFactory,
  defineProvider,
} from '../index';
import type { StandardSchemaV1, VelaEnv } from '../index';
import {
  InjectQueue,
  QueueBatchError,
  QueueClient,
  QueueDispatchBinding,
  QueueModule,
  QueueRegistry,
  defineQueueJob,
  inline,
  Process,
  Processor,
  queueToken,
} from '../queue';
import type {
  QueueDriver,
  QueueDriverContext,
  QueueEnqueueRequest,
  QueueJob,
  QueueJobOutput,
} from '../queue';

const count: StandardSchemaV1<{ count: string }, { count: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('count' in value) ||
        typeof value.count !== 'string'
      ) {
        return { issues: [{ message: 'count must be a string' }] };
      }
      return { value: { count: Number(value.count) } };
    },
  },
};
const tally = defineQueueJob('tally', count);

/** A producer-only driver that records what it accepted. */
function recordingDriver(): QueueDriver & { sent: QueueJob[] } {
  const sent: QueueJob[] = [];
  return {
    kind: 'recording',
    sent,
    async enqueue(job) {
      sent.push(job);
    },
  };
}

describe('QueueModule.registerQueue', () => {
  it('provides @InjectQueue clients in a feature module that does not import forRoot', async () => {
    const seen: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Processor('email')
    @Injectable()
    class EmailProcessor {
      @Process('welcome')
      welcome(job: QueueJob<{ user: string }>) {
        seen.push(job.data.user);
      }
    }

    @Injectable()
    class Signup {
      constructor(@InjectQueue('email') readonly email: QueueClient) {}
    }

    @Module({
      imports: [QueueModule.registerQueue({ name: 'email' })],
      providers: [Signup, EmailProcessor],
    })
    class SignupModule {}

    @Module({ imports: [QueueModule.forRoot({ driver }), SignupModule] })
    class App {}

    const app = await VelaFactory.create(App);
    const signup = app.get(Signup);
    expect(signup.email).toBe(app.get(queueToken('email')));
    expect(signup.email.name).toBe('email');
    await signup.email.add('welcome', { user: 'ada' });
    await driver.flush();
    expect(seen).toEqual(['ada']);
    await app.close();
  });

  it('registers several queues in one call', async () => {
    @Injectable()
    class Producers {
      constructor(
        @InjectQueue('email') readonly email: QueueClient,
        @InjectQueue('sms') readonly sms: QueueClient,
      ) {}
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.registerQueue({ name: 'email' }, { name: 'sms' }),
      ],
      providers: [Producers],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect([app.get(Producers).email.name, app.get(Producers).sms.name]).toEqual(['email', 'sms']);
    await app.close();
  });

  it('deduplicates one queue registered by several modules and merges consumer pins', async () => {
    @Injectable()
    class Producer {
      constructor(@InjectQueue('email') readonly email: QueueClient) {}
    }
    @Module({
      imports: [QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' })],
      providers: [Producer],
    })
    class Producers {}
    @Module({
      imports: [
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
        QueueModule.registerQueue({ name: 'email', consumer: 'email-production' }),
      ],
    })
    class Consumers {}
    @Module({ imports: [QueueModule.forRoot({ driver: recordingDriver() }), Producers, Consumers] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.getContainer().getOwnerModuleIds(queueToken('email'))).toHaveLength(1);
    expect(app.get(QueueRegistry).get('email')).toEqual({
      name: 'email',
      binding: 'EMAIL_QUEUE',
      consumers: ['email-production'],
    });
    expect(app.get(QueueRegistry).get('missing')).toBeUndefined();
    expect(app.entrypoints.ofKind('queue:registration').map((entry) => entry.meta)).toEqual([
      { name: 'email', binding: 'EMAIL_QUEUE', consumers: ['email-production'] },
    ]);
    await app.close();
  });

  it('rejects one queue registered with conflicting bindings at bootstrap', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
        QueueModule.registerQueue({ name: 'email', binding: 'OTHER_QUEUE' }),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(
      /Queue 'email' is registered with conflicting bindings 'EMAIL_QUEUE' and 'OTHER_QUEUE'/,
    );
  });

  it('validates registrations when they are declared', () => {
    expect(() => QueueModule.registerQueue({ name: ' ' })).toThrow(TypeError);
    expect(() => QueueModule.registerQueue({ name: 'email', binding: 'not a binding' })).toThrow(
      /binding/,
    );
    expect(() => QueueModule.registerQueue({ name: 'email', consumer: '' })).toThrow(/consumer/);
  });

  it('requires QueueModule.forRoot before a registered client resolves', async () => {
    @Module({ imports: [QueueModule.registerQueue({ name: 'orphan' })] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(/QueueModule\.forRoot/);
  });

  it('rejects two different QueueModule.forRoot configurations in one application', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.registerQueue({ name: 'email' }),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(/QueueModule\.forRoot\(\) .*once/);
  });
});

describe('driver factories', () => {
  it('receive the application ENV and registered queues, once per application', async () => {
    const contexts: QueueDriverContext[] = [];
    const root = QueueModule.forRoot({
      driver: (context) => {
        contexts.push(context);
        return recordingDriver();
      },
    });
    @Module({ imports: [root, QueueModule.registerQueue({ name: 'jobs', binding: 'JOBS' })] })
    class App {}

    const env: VelaEnv = { region: 'test' };
    const first = await VelaFactory.create(App, { env });
    const second = await VelaFactory.create(App);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.env).toBe(env);
    expect(contexts[1]!.env).toBeUndefined();
    expect(contexts[0]!.queues.all()).toEqual([{ name: 'jobs', binding: 'JOBS', consumers: [] }]);
    expect(contexts[0]!.queues).toBe(first.get(QueueRegistry));
    await first.close();
    await second.close();
  });
});

describe('module dispatch', () => {
  it('rejects platform delivery for a queue this application did not register', async () => {
    @Module({ imports: [QueueModule.forRoot({}), QueueModule.registerQueue({ name: 'known' })] })
    class App {}
    const app = await VelaFactory.create(App);
    const binding = app.get(QueueDispatchBinding);
    await expect(
      binding.dispatch({ id: 'j', queue: 'unknown', name: 'n', data: {}, attempt: 1 }),
    ).rejects.toThrow(/Queue 'unknown' is not registered/);
    await app.close();
  });

  it('boots signed dispatch with a producer-only driver: delivery is owned by the consumer', async () => {
    const driver = recordingDriver();
    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'queue-registration-secret' })],
      exports: [URL_SIGNING_SECRET],
    })
    class Secret {}
    @Controller('/jobs')
    class Jobs {
      @Post('run', { name: 'jobs.run' })
      @SignedInvocation()
      run() {
        return { ok: true };
      }
    }
    @Module({
      imports: [
        Secret,
        QueueModule.forRoot({
          driver,
          dispatch: { kind: 'signed', target: () => ({ route: 'jobs.run' }) },
        }),
        QueueModule.registerQueue({ name: 'remote' }),
      ],
      controllers: [Jobs],
    })
    class App {}
    const app = await VelaFactory.create(App);
    await app.get(queueToken('remote')).add('run', {});
    expect(driver.sent.map((job) => job.queue)).toEqual(['remote']);
    await app.close();
  });
});

describe('QueueClient.addBulk', () => {
  it('validates every typed job before the driver accepts any, then enqueues in order', async () => {
    const driver = recordingDriver();
    const client = new QueueClient('jobs', driver);
    const invalid = [
      { job: tally, data: { count: '1' } },
      { job: tally, data: { count: 2 } },
    ] as const;
    await expect(
      // @ts-expect-error the second job's wire input must be a string
      client.addBulk(invalid),
    ).rejects.toThrow('Validation failed');
    expect(driver.sent).toEqual([]);

    const jobs = await client.addBulk([
      { job: tally, data: { count: '1' } },
      { job: tally, data: { count: '2' }, options: {} },
    ]);
    const first: QueueJob<{ count: string }> = jobs[0];
    expect(first.data).toEqual({ count: '1' });
    expect(driver.sent.map((job) => job.data)).toEqual([{ count: '1' }, { count: '2' }]);
    expect(driver.sent.map((job) => job.id)).toEqual(jobs.map((job) => job.id));
    expect(await client.addBulk([])).toEqual([]);
  });

  it('accepts named jobs and hands the whole batch to enqueueBatch when the driver has it', async () => {
    const batches: QueueEnqueueRequest[][] = [];
    const enqueue = vi.fn(async () => {});
    const client = new QueueClient('jobs', {
      kind: 'batching',
      enqueue,
      async enqueueBatch(requests) {
        batches.push([...requests]);
      },
    });
    const jobs = await client.addBulk([
      { job: 'a', data: 1 },
      { job: 'b', data: 2, options: { delayMs: 5 } },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((request) => [request.job.name, request.options])).toEqual([
      ['a', undefined],
      ['b', { delayMs: 5 }],
    ]);
    expect(batches[0]!.map((request) => request.job)).toEqual(jobs);
  });

  it('falls back to one enqueue per job and rejects a partial failure with the accepted ids', async () => {
    let calls = 0;
    const client = new QueueClient('jobs', {
      kind: 'flaky',
      async enqueue() {
        if (++calls === 3) throw new Error('transport down');
      },
    });
    const failure = await client
      .addBulk([1, 2, 3, 4].map((value) => ({ job: 'n', data: value })))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(QueueBatchError);
    const batchError = failure as QueueBatchError;
    expect(batchError.accepted).toHaveLength(2);
    expect(batchError.rejected).toHaveLength(2);
    expect(batchError.message).toContain(batchError.accepted.join(', '));
    expect(batchError.cause).toEqual(new Error('transport down'));
    expect(calls).toBe(3);
  });

  it('delivers bulk jobs to processors through the inline driver', async () => {
    const seen: number[] = [];
    @Processor('jobs')
    @Injectable()
    class Consumer {
      @Process(tally) handle(job: QueueJob<QueueJobOutput<typeof tally>>) {
        seen.push(job.data.count);
      }
    }
    const driver = inline({ mode: 'manual' });
    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'jobs' })],
      providers: [Consumer],
    })
    class App {}
    const app = await VelaFactory.create(App);
    await app.get(queueToken('jobs')).addBulk([
      { job: tally, data: { count: '3' } },
      { job: tally, data: { count: '4' } },
    ]);
    expect(await driver.flush()).toBe(2);
    expect(seen).toEqual([3, 4]);
    await app.close();
  });
});
