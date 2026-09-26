import { describe, expect, it, vi } from 'vitest';
import {
  Controller,
  Global,
  Injectable,
  Module,
  Post,
  URL_SIGNING_SECRET,
  VelaFactory,
  defineProvider,
} from '../index';
import { SignedInvocation } from '../dispatch/index';
import type { VelaEnv } from '../index';
import type { StandardSchemaV1 } from '../validation/index';
import { countRegisteredClasses } from '../internal';
import {
  InjectQueue,
  QueueBatchError,
  QueueClient,
  QueueDispatchBinding,
  QueueModule,
  QueueRegistry,
  defineQueueJob,
  dispatchQueueJob,
  inline,
  Process,
  Processor,
  QUEUE_DRIVER,
  queueToken,
} from '../queue';
import type {
  QueueDispatchMode,
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

type SignedQueueDispatch = Extract<QueueDispatchMode, { kind: 'signed' }>;

/** Builds a signed policy per path: every policy has the same source. */
function signedTo(path: string): SignedQueueDispatch {
  return { kind: 'signed', target: () => ({ path }) };
}

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

describe('QueueModule.forFeature', () => {
  it('accepts empty readonly features without requiring queue infrastructure', async () => {
    @Module({ imports: [QueueModule.forFeature([] as const)] })
    class App {}
    const app = await VelaFactory.create(App);
    expect(app.getContainer().has(QUEUE_DRIVER)).toBe(false);
    await app.close();
  });

  it('provides @InjectQueue clients in a feature module that does not import forRoot', async () => {
    const seen: string[] = [];
    const driver = inline({ mode: 'manual' });

    @Processor('email')
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
      imports: [QueueModule.forFeature([{ name: 'email' }])],
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
        QueueModule.forFeature([{ name: 'email' }, { name: 'sms' }]),
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
      imports: [QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }])],
      providers: [Producer],
    })
    class Producers {}
    @Module({
      imports: [
        QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }]),
        QueueModule.forFeature([{ name: 'email', consumer: 'email-production' }]),
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
        QueueModule.forFeature([{ name: 'email', binding: 'EMAIL_QUEUE' }]),
        QueueModule.forFeature([{ name: 'email', binding: 'OTHER_QUEUE' }]),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(
      /Queue 'email' is registered with conflicting bindings 'EMAIL_QUEUE' and 'OTHER_QUEUE'/,
    );
  });

  it('declares no class per registration, however many queues or calls', async () => {
    const before = countRegisteredClasses();
    const registrations = [0, 1, 2].map((index) =>
      QueueModule.forFeature([{ name: `bulk-${index}` }, { name: 'shared' }]),
    );
    registrations.push(QueueModule.forFeature([{ name: 'bulk-0', consumer: 'bulk-worker' }]));
    expect(countRegisteredClasses()).toBe(before);

    @Module({ imports: [QueueModule.forRoot({ driver: recordingDriver() }), ...registrations] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(QueueRegistry).all()).toEqual([
      { name: 'bulk-0', binding: undefined, consumers: ['bulk-worker'] },
      { name: 'bulk-1', binding: undefined, consumers: [] },
      { name: 'bulk-2', binding: undefined, consumers: [] },
      { name: 'shared', binding: undefined, consumers: [] },
    ]);
    await app.close();
  });

  it('validates registrations when they are declared', () => {
    expect(() => QueueModule.forFeature([{ name: ' ' }])).toThrow(TypeError);
    expect(() => QueueModule.forFeature([{ name: 'email', binding: 'not a binding' }])).toThrow(
      /binding/,
    );
    expect(() => QueueModule.forFeature([{ name: 'email', consumer: '' }])).toThrow(/consumer/);
  });

  it('requires QueueModule.forRoot before a registered client resolves', async () => {
    @Module({ imports: [QueueModule.forFeature([{ name: 'orphan' }])] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(/QueueModule\.forRoot/);
  });

  it('rejects two different QueueModule.forRoot configurations in one application', async () => {
    @Module({
      imports: [
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.forRoot({ driver: recordingDriver() }),
        QueueModule.forFeature([{ name: 'email' }]),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(/QueueModule\.forRoot\(\) .*once/);
  });

  it('rejects two forRoot dispatch policies that differ in target, method or TTL', async () => {
    const driver = recordingDriver();
    const policy = signedTo('/jobs/a');
    // signedTo('/jobs/b') has the same source as `policy`; only its capture differs.
    const conflicting: SignedQueueDispatch[] = [
      signedTo('/jobs/b'),
      { ...policy, method: 'PUT' },
      { ...policy, ttlSeconds: 30 },
    ];
    await Promise.all(
      conflicting.map((other) => {
        @Module({
          imports: [
            QueueModule.forRoot({ driver, dispatch: policy }),
            QueueModule.forRoot({ driver, dispatch: other }),
            QueueModule.forFeature([{ name: 'email' }]),
          ],
        })
        class App {}
        return expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
          /QueueModule\.forRoot\(\) is imported with different options/,
        );
      }),
    );

    // The same driver and policy objects imported again deduplicate.
    @Module({
      imports: [
        QueueModule.forRoot({ driver, dispatch: policy }),
        QueueModule.forRoot({ driver, dispatch: policy }),
        QueueModule.forFeature([{ name: 'email' }]),
      ],
    })
    class Same {}
    const app = await VelaFactory.create(Same);
    expect(app.getContainer().getOwnerModuleIds(QUEUE_DRIVER)).toHaveLength(1);
    await app.close();
  });

  it('rejects forRootAsync next to a different forRoot or forRootAsync configuration', async () => {
    const driver = recordingDriver();
    const factory = { inject: [], useFactory: async () => ({ driver }) } as const;
    const others = [QueueModule.forRoot(), QueueModule.forRootAsync({ ...factory })];
    await Promise.all(
      others.map((other) => {
        @Module({
          imports: [
            QueueModule.forRootAsync(factory),
            other,
            QueueModule.forFeature([{ name: 'email' }]),
          ],
        })
        class App {}
        return expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
          /QueueModule\.forRoot\(\) is imported with different options/,
        );
      }),
    );

    // One async options object imported again deduplicates.
    @Module({
      imports: [
        QueueModule.forRootAsync(factory),
        QueueModule.forRootAsync(factory),
        QueueModule.forFeature([{ name: 'email' }]),
      ],
    })
    class Same {}
    const app = await VelaFactory.create(Same);
    expect(app.getContainer().getOwnerModuleIds(QUEUE_DRIVER)).toHaveLength(1);
    await app.close();
  });

  it('rejects two forRootAsync configurations that share an explicit key', async () => {
    const driver = recordingDriver();
    const direct = {
      key: 'q',
      inject: [],
      useFactory: async () => ({ driver }),
    } as const;
    const signed = {
      key: 'q',
      inject: [],
      useFactory: async () => ({ driver, dispatch: signedTo('/jobs/a') }),
    } as const;
    // A shared key must not merge the signed policy into the direct one.
    @Module({
      imports: [
        QueueModule.forRootAsync(direct),
        QueueModule.forRootAsync(signed),
        QueueModule.forFeature([{ name: 'email' }]),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
      /QueueModule\.forRoot\(\) is imported with different options/,
    );

    // The same keyed options object imported again still deduplicates.
    @Module({
      imports: [
        QueueModule.forRootAsync(signed),
        QueueModule.forRootAsync(signed),
        QueueModule.forFeature([{ name: 'email' }]),
      ],
    })
    class Same {}
    const app = await VelaFactory.create(Same);
    expect(app.getContainer().getOwnerModuleIds(QUEUE_DRIVER)).toHaveLength(1);
    await app.close();
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
    @Module({ imports: [root, QueueModule.forFeature([{ name: 'jobs', binding: 'JOBS' }])] })
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
    @Module({ imports: [QueueModule.forRoot({}), QueueModule.forFeature([{ name: 'known' }])] })
    class App {}
    const app = await VelaFactory.create(App);
    const binding = app.get(QueueDispatchBinding);
    await expect(
      binding.dispatch({ id: 'j', queue: 'unknown', name: 'n', data: {}, attempt: 1 }),
    ).rejects.toThrow(/Queue 'unknown' is not registered/);
    await app.close();
  });

  it('rejects an unhandled job unless the caller explicitly ignores it', async () => {
    @Module({ imports: [QueueModule.forRoot({}), QueueModule.forFeature([{ name: 'known' }])] })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'silent' });
    const binding = app.get(QueueDispatchBinding);
    const job = { id: 'j', queue: 'known', name: 'n', data: {}, attempt: 1 };
    try {
      await expect(binding.dispatch(job)).rejects.toThrow(/No processor for queue 'known'/);
      // Options that leave `unhandled` out keep the platform default.
      await expect(binding.dispatch(job, {})).rejects.toThrow(/No processor for queue 'known'/);
      await expect(binding.dispatch(job, { unhandled: undefined })).rejects.toThrow(
        /No processor for queue 'known'/,
      );
      await expect(binding.dispatch(job, { unhandled: 'ignore' })).resolves.toEqual({
        handled: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('dispatchQueueJob rejects a misspelled or removed job unless the caller ignores it', async () => {
    @Processor('known')
    class Known {
      @Process('welcome')
      welcome() {}
    }
    @Module({
      imports: [QueueModule.forRoot({}), QueueModule.forFeature([{ name: 'known' }])],
      providers: [Known],
    })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'silent' });
    const job = { id: 'j', queue: 'known', name: 'welcom', data: {}, attempt: 1 };
    try {
      // A custom transport acknowledges when this resolves, so it must not
      // resolve for a job nothing handled.
      await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job)).rejects.toThrow(
        /No handler for job 'welcom' on queue 'known'/,
      );
      await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job, {})).rejects.toThrow(
        /No handler for job 'welcom'/,
      );
      await expect(
        dispatchQueueJob(app.getContainer(), app.entrypoints, job, { unhandled: 'ignore' }),
      ).resolves.toEqual({ handled: 0 });
    } finally {
      await app.close();
    }
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
        QueueModule.forFeature([{ name: 'remote' }]),
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
    class Consumer {
      @Process(tally) handle(job: QueueJob<QueueJobOutput<typeof tally>>) {
        seen.push(job.data.count);
      }
    }
    const driver = inline({ mode: 'manual' });
    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.forFeature([{ name: 'jobs' }])],
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
