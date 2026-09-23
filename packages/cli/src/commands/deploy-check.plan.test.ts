import { describe, expect, it } from 'vitest';
import { Cron, Injectable, Module, ScheduleModule, UseGuards, VelaFactory } from '@velajs/vela';
import { Process, Processor, QueueModule, type QueueDriver } from '@velajs/vela/queue';
import { collectEntrypoints } from '../introspect.js';
import { checkDeployment } from './deploy-check.plan.js';

const config = (selected: object = {}) => ({
  name: 'api',
  main: 'src/worker.ts',
  compatibility_date: '2026-09-20',
  env: { staging: selected },
});
const row = (kind: string, meta: unknown) => ({
  kind,
  target: 'Jobs#run',
  meta:
    kind === 'schedule:cron' && typeof meta === 'object' && meta !== null
      ? { methodName: 'run', ...meta }
      : meta,
});

describe('deployment alignment', () => {
  it('checks registered queue producers, module consumers and service bindings', () => {
    const snapshot = [
      row('cf:queue:module', { consumers: ['notifications-staging'] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
      row('queue:registration', { name: 'sms', consumers: ['notifications-staging'] }),
      row('queue', { queueName: 'email' }),
      row('queue', { queueName: 'sms' }),
      row('rpc:client', { name: 'catalog', binding: 'CATALOG' }),
    ];
    const valid = config({
      queues: {
        producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
        consumers: [{ queue: 'email-staging' }, { queue: 'notifications-staging' }],
      },
      services: [{ binding: 'CATALOG', service: 'catalog-staging' }],
    });
    expect(checkDeployment(valid, 'staging', snapshot).errors).toEqual([]);
    expect(
      checkDeployment(config(), 'staging', snapshot)
        .errors.map((x) => x.code)
        .toSorted(),
    ).toEqual([
      'missing-queue-consumer',
      'missing-queue-producer',
      'missing-service-binding',
      'queue-processor-without-consumer',
    ]);
  });

  it("derives a registered binding's physical queue from its Wrangler producer", () => {
    const snapshot = [
      row('cf:queue:module', { consumers: [] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
      row('queue', { queueName: 'email' }),
    ];
    const producers = [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }];
    expect(checkDeployment(config({ queues: { producers } }), 'staging', snapshot).errors).toEqual([
      {
        code: 'missing-queue-consumer',
        message: expect.stringMatching(/"email-staging".*"email"/),
      },
    ]);
    expect(
      checkDeployment(
        config({ queues: { producers, consumers: [{ queue: 'email-staging' }] } }),
        'staging',
        snapshot,
      ).status,
    ).toBe('passed');
  });

  it('flags a registered binding missing from the Wrangler producers', () => {
    const snapshot = [
      row('cf:queue:module', { consumers: [] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
    ];
    expect(
      checkDeployment(config({ kv_namespaces: [{ binding: 'EMAIL_QUEUE' }] }), 'staging', snapshot)
        .errors,
    ).toEqual([
      {
        code: 'missing-queue-producer',
        message: expect.stringMatching(/"email".*"EMAIL_QUEUE"/),
      },
    ]);
  });

  it('flags processors whose queue is unregistered or has no consumer', () => {
    const snapshot = [
      row('cf:queue:module', { consumers: [] }),
      row('queue:registration', { name: 'email', consumers: [] }),
      row('queue', { queueName: 'email' }),
      row('queue', { queueName: 'orders' }),
    ];
    expect(checkDeployment(config(), 'staging', snapshot).errors).toEqual([
      {
        code: 'unregistered-queue-processor',
        message: expect.stringContaining('"orders"'),
      },
      {
        code: 'queue-processor-without-consumer',
        message: expect.stringContaining('"email"'),
      },
    ]);
  });

  it('warns instead when a processed queue may arrive through an unpinned consumer', () => {
    const result = checkDeployment(
      config({ queues: { consumers: [{ queue: 'shared-staging' }] } }),
      'staging',
      [
        row('cf:queue:module', { consumers: [] }),
        row('queue:registration', { name: 'sms', consumers: [] }),
        row('queue', { queueName: 'sms' }),
      ],
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('unverified-queue-consumer');
  });

  it('flags a selected consumer queue that no raw consumer or processor expects', () => {
    const result = checkDeployment(
      config({
        queues: {
          consumers: [{ queue: 'email-staging' }, { queue: 'extra-staging' }, { queue: 'raw' }],
        },
      }),
      'staging',
      [
        row('cf:queue:module', { consumers: ['email-staging'] }),
        row('queue:registration', { name: 'email', consumers: ['email-staging'] }),
        row('queue', { queueName: 'email' }),
        row('cf:queue', { queueName: 'raw' }),
      ],
    );
    expect(result.errors).toEqual([
      {
        code: 'unhandled-queue-consumer',
        message: expect.stringContaining('"extra-staging"'),
      },
    ]);
  });

  it('flags a physical queue a raw @QueueConsumer takes from a processed registration', () => {
    const queues = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
      consumers: [{ queue: 'email-staging' }, { queue: 'jobs-staging' }],
    };
    // The producer's physical queue is claimed by a raw consumer, so the
    // native module consumer never receives the email jobs.
    const produced = checkDeployment(config({ queues }), 'staging', [
      row('cf:queue:module', { consumers: [] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
      row('queue', { queueName: 'email' }),
      row('cf:queue', { queueName: 'email-staging' }),
      row('cf:queue', { queueName: 'jobs-staging' }),
    ]);
    expect(produced.errors).toEqual([
      {
        code: 'queue-consumer-claimed-by-raw',
        message: expect.stringMatching(/"email-staging".*@QueueConsumer.*"email"/),
      },
    ]);
    // A pin on a raw consumer's queue fails like bootstrap does, processed or not.
    const pinned = checkDeployment(
      config({ queues: { consumers: [{ queue: 'jobs-staging' }] } }),
      'staging',
      [
        row('cf:queue:module', { consumers: ['jobs-staging'] }),
        row('queue:registration', { name: 'sms', consumers: ['jobs-staging'] }),
        row('cf:queue', { queueName: 'jobs-staging' }),
      ],
    );
    expect(pinned.errors.map((error) => error.code)).toEqual(['queue-consumer-claimed-by-raw']);
  });

  it('flags an unpinned queue whose producer sends to a queue pinned by other registrations', () => {
    const queues = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'shared-staging' }],
      consumers: [{ queue: 'shared-staging' }],
    };
    const snapshot = [
      row('cf:queue:module', { consumers: ['shared-staging'] }),
      row('queue:registration', { name: 'sms', consumers: ['shared-staging'] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
      row('queue', { queueName: 'sms' }),
      row('queue', { queueName: 'email' }),
    ];
    expect(checkDeployment(config({ queues }), 'staging', snapshot).errors).toEqual([
      {
        code: 'queue-sent-to-pinned-queue',
        message: expect.stringMatching(/"email".*"shared-staging".*"sms"/),
      },
    ]);
    // Pinning the queue to the shared physical queue accepts its jobs there.
    snapshot[2] = row('queue:registration', {
      name: 'email',
      binding: 'EMAIL_QUEUE',
      consumers: ['shared-staging'],
    });
    expect(checkDeployment(config({ queues }), 'staging', snapshot).errors).toEqual([]);
  });

  it('flags a pinned registration whose producer binding sends outside its pins', () => {
    const queues = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
      consumers: [{ queue: 'notifications-staging' }],
    };
    const snapshot = [
      row('cf:queue:module', { consumers: ['notifications-staging'] }),
      row('queue:registration', {
        name: 'email',
        binding: 'EMAIL_QUEUE',
        consumers: ['notifications-staging'],
      }),
      row('queue', { queueName: 'email' }),
    ];
    // The consumer accepts email jobs only from its pin, so every job the
    // producer sends to email-staging would be rejected and dead-lettered.
    expect(checkDeployment(config({ queues }), 'staging', snapshot).errors).toEqual([
      {
        code: 'queue-producer-outside-pins',
        message: expect.stringMatching(
          /"email".*"EMAIL_QUEUE".*"email-staging".*"notifications-staging"/,
        ),
      },
    ]);
    // A producer-only Worker that shares the registration is checked the same way.
    expect(
      checkDeployment(config({ queues: { producers: queues.producers } }), 'staging', [
        row('queue:registration', {
          name: 'email',
          binding: 'EMAIL_QUEUE',
          consumers: ['notifications-staging'],
        }),
      ]).errors.map((error) => error.code),
    ).toEqual(['queue-producer-outside-pins']);
    // Sending to one of its pins is accepted.
    const aligned = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'notifications-staging' }],
      consumers: queues.consumers,
    };
    expect(checkDeployment(config({ queues: aligned }), 'staging', snapshot).errors).toEqual([]);
  });

  it('flags the producer queue of a pinned processed registration that a raw consumer claims', () => {
    const queues = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
      consumers: [{ queue: 'email-pinned' }, { queue: 'email-staging' }],
    };
    const result = checkDeployment(config({ queues }), 'staging', [
      row('cf:queue:module', { consumers: ['email-pinned'] }),
      row('queue:registration', {
        name: 'email',
        binding: 'EMAIL_QUEUE',
        consumers: ['email-pinned'],
      }),
      row('queue', { queueName: 'email' }),
      row('cf:queue', { queueName: 'email-staging' }),
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'queue-producer-outside-pins' }),
      {
        code: 'queue-consumer-claimed-by-raw',
        message: expect.stringMatching(/"email-staging".*@QueueConsumer.*"email"/),
      },
    ]);
  });

  it('flags the producer queue of a registration this Worker only produces to a raw consumer', () => {
    const queues = {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
      consumers: [{ queue: 'email-staging' }],
    };
    // No @Processor('email') runs here, but the Worker's own raw consumer
    // claims the physical queue the binding sends every email job to.
    const snapshot = [
      row('cf:queue:module', { consumers: [] }),
      row('queue:registration', { name: 'email', binding: 'EMAIL_QUEUE', consumers: [] }),
      row('cf:queue', { queueName: 'email-staging' }),
    ];
    expect(checkDeployment(config({ queues }), 'staging', snapshot).errors).toEqual([
      {
        code: 'queue-consumer-claimed-by-raw',
        message: expect.stringMatching(/"email-staging".*@QueueConsumer.*"email"/),
      },
    ]);
    // A Worker whose driver publishes no module consumer is checked the same way.
    expect(
      checkDeployment(config({ queues }), 'staging', snapshot.slice(1)).errors.map(
        (error) => error.code,
      ),
    ).toEqual(['queue-consumer-claimed-by-raw']);
  });

  it('does not require consumers for processors an in-process driver delivers', () => {
    const result = checkDeployment(config(), 'staging', [
      row('queue:registration', { name: 'email', consumers: [] }),
      row('queue', { queueName: 'email' }),
    ]);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['cf:queue:producer', { logicalQueue: 'tasks', binding: 'TASKS' }],
    ['cf:queue:module', { queueName: 'tasks-staging', logicalQueue: 'tasks' }],
  ])('rejects a snapshot with the removed %s queue metadata', (kind, meta) => {
    expect(checkDeployment(config(), 'staging', [row(kind, meta)]).errors).toEqual([
      expect.objectContaining({
        code: 'stale-entrypoint-snapshot',
        message: expect.stringMatching(/regenerate/),
      }),
    ]);
  });

  it('rejects malformed queue registration metadata', () => {
    expect(
      checkDeployment(config(), 'staging', [
        row('queue:registration', { name: 'email', binding: 4, consumers: [] }),
        row('queue:registration', { consumers: [] }),
        row('queue', { queueName: '' }),
      ]).errors.map((error) => error.code),
    ).toEqual(['invalid-metadata', 'invalid-metadata', 'invalid-metadata']);
  });

  it('checks the queue projection of an actual application', async () => {
    const driver: QueueDriver = {
      kind: 'native',
      entrypoints: [{ kind: 'cf:queue:module', meta: { consumers: [] } }],
      async enqueue() {},
    };
    @Processor('email')
    class EmailProcessor {
      @Process('welcome')
      welcome() {}
    }
    /* oxlint-disable typescript/no-extraneous-class -- The decorated class is the module's identity. */
    @Module({
      imports: [
        QueueModule.forRoot({ driver }),
        QueueModule.registerQueue({ name: 'email', binding: 'EMAIL_QUEUE' }),
      ],
      providers: [EmailProcessor],
    })
    class AppModule {}
    /* oxlint-enable typescript/no-extraneous-class */
    const app = await VelaFactory.create(AppModule);
    try {
      const snapshot = JSON.parse(JSON.stringify(collectEntrypoints(app)));
      const queues = {
        producers: [{ binding: 'EMAIL_QUEUE', queue: 'email-staging' }],
        consumers: [{ queue: 'email-staging' }],
      };
      expect(checkDeployment(config({ queues }), 'staging', snapshot).errors).toEqual([]);
      expect(
        checkDeployment(
          config({ queues: { producers: queues.producers } }),
          'staging',
          snapshot,
        ).errors.map((error) => error.code),
      ).toEqual(['missing-queue-consumer']);
    } finally {
      await app.close();
    }
  });

  it('consumes the actual Vela entrypoint-list projection without constructing another app', async () => {
    let constructed = 0;
    @Injectable()
    class Jobs {
      constructor() {
        constructed++;
      }
      @Cron('0 * * * *', { dialect: 'cloudflare', timeZone: 'UTC' })
      hourly() {}
    }
    /* oxlint-disable typescript/no-extraneous-class -- The decorated class is the module's identity. */
    @Module({ providers: [Jobs] })
    class AppModule {}
    /* oxlint-enable typescript/no-extraneous-class */
    const app = await VelaFactory.create(AppModule);
    try {
      const snapshot = JSON.parse(JSON.stringify(collectEntrypoints(app)));
      expect(snapshot.some((entry: { kind: string }) => entry.kind === 'schedule:cron')).toBe(true);
      const result = checkDeployment(
        config({ triggers: { crons: ['0 * * * *'] } }),
        'staging',
        snapshot,
      );
      expect(result.errors).toEqual([]);
      expect(constructed).toBe(1);
    } finally {
      await app.close();
    }
  });
  it.each([
    ['0 9 * * 1', /weekday field uses numbers/],
    ['0 9 1 * MON', /both day-of-month and weekday/],
  ])('flags the dialect-ambiguous cron %s', (expression, reason) => {
    const trigger = config({ triggers: { crons: [expression] } });
    expect(
      checkDeployment(trigger, 'staging', [row('schedule:cron', { expression })]).errors,
    ).toEqual([
      {
        code: 'ambiguous-cron-dialect',
        message: expect.stringMatching(reason),
      },
    ]);
    expect(
      checkDeployment(trigger, 'staging', [row('schedule:cron', { expression })]).errors[0],
    ).toMatchObject({ message: expect.stringMatching(/dialect: 'cloudflare'.*'unix'/) });
    expect(
      checkDeployment(trigger, 'staging', [
        row('schedule:cron', { expression, dialect: 'cloudflare' }),
      ]).errors,
    ).toEqual([]);
  });

  it('rejects explicitly conflicting core cron dialect or time zone', () => {
    for (const options of [{ dialect: 'unix' }, { timeZone: 'local' }]) {
      const result = checkDeployment(config({ triggers: { crons: ['0 * * * *'] } }), 'staging', [
        row('schedule:cron', { expression: '0 * * * *', ...options }),
      ]);
      expect(result.errors.some((e) => e.code === 'incompatible-cron-options')).toBe(true);
    }
  });
  it('matches exact cron/queue keys and a contributed WebSocket gateway binding', () => {
    const result = checkDeployment(
      config({
        triggers: { crons: ['0 * * * *'] },
        queues: { consumers: [{ queue: 'jobs' }] },
        durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
      }),
      'staging',
      [
        row('schedule:cron', JSON.stringify({ expression: '0 * * * *', methodName: 'run' })),
        row('cf:queue', { queueName: 'jobs' }),
        row('websocket', { options: { binding: 'ROOM' }, dispatcher: '[WsDispatcher]' }),
      ],
    );
    expect(result.status).toBe('passed');
  });

  it('accepts Cloudflare Sunday and Quartz-style extensions with the shared parser', () => {
    // Native last-day offsets are documented by Cloudflare's Saffron parser article.
    const crons = [
      '0 0 * * 1',
      '59 23 LW * *',
      '0 18 * * 6L',
      '0 0 * * MON#2',
      '0 0 L-1 FEB *',
      '0 0 L-1W FEB *',
      '55-5/5 20-4/2 * NOV-FEB FRI-MON',
    ];
    expect(
      checkDeployment(
        config({ triggers: { crons } }),
        'staging',
        crons.map((expression) => row('schedule:cron', { expression, dialect: 'cloudflare' })),
      ).errors,
    ).toEqual([]);
  });

  it('does not silently normalize differing exact trigger strings', () => {
    const result = checkDeployment(config({ triggers: { crons: ['0 0 * * SUN'] } }), 'staging', [
      row('schedule:cron', { expression: '0 0 * * 1', dialect: 'cloudflare' }),
    ]);
    expect(result.errors.map((e) => e.code)).toEqual([
      'missing-cron-trigger',
      'unhandled-cron-trigger',
    ]);
  });

  it.each(['99 * * * *', '* * * * 0', '* * * * * *', 'garbage'])(
    'rejects invalid Cloudflare syntax %s',
    (cron) => {
      expect(
        checkDeployment(config({ triggers: { crons: [cron] } }), 'staging', [
          row('schedule:cron', { expression: cron }),
        ]).errors.some((e) => e.code === 'invalid-cron'),
      ).toBe(true);
    },
  );

  it('detects missing and unhandled queues independently', () => {
    expect(
      checkDeployment(config({ queues: { consumers: [{ queue: 'other' }] } }), 'staging', [
        row('cf:queue', { queueName: 'jobs' }),
      ]).errors.map((e) => e.code),
    ).toEqual(['missing-queue-consumer', 'unhandled-queue-consumer']);
  });

  it('requires the right binding kind in the selected environment', () => {
    expect(
      checkDeployment(config({ kv_namespaces: [{ binding: 'ROOM' }] }), 'staging', [
        row('websocket', { binding: 'ROOM' }),
      ]).errors[0]?.code,
    ).toBe('missing-durable-binding');
  });

  it('handles empty-kind rows and unknown optional kinds without constructing anything', () => {
    const result = checkDeployment(config(), 'staging', [
      { kind: 'cf:queue', target: '(no entrypoints)', meta: '' },
      row('rpc', { some: 'metadata' }),
    ]);
    expect(result.status).toBe('passed');
    expect(result.warnings[0]?.code).toBe('static-only');
  });

  it('reports unsupported interval jobs and malformed known metadata', () => {
    expect(
      checkDeployment(config(), 'staging', [
        row('schedule:interval', { ms: 5000 }),
        row('schedule:cron', { expression: 4 }),
        row('cf:queue', null),
      ]).errors.map((e) => e.code),
    ).toEqual(['unsupported-interval', 'invalid-metadata', 'invalid-metadata']);
  });

  it.each([null, {}, [{ kind: 'cf:queue', meta: {} }], [row('cf:queue', '{broken')]])(
    'rejects malformed snapshots',
    (rows) => {
      expect(() => checkDeployment(config(), 'staging', rows)).toThrow();
    },
  );

  it.each([
    ['cf:scheduled', { cron: '0 * * * *', methodName: 'run' }],
    ['cf:vela-cron', { expression: '0 * * * *', methodName: 'run' }],
  ])('rejects a snapshot with the removed %s kind and asks to regenerate it', (kind, meta) => {
    const result = checkDeployment(config({ triggers: { crons: ['0 * * * *'] } }), 'staging', [
      row(kind, meta),
      row('schedule:cron', { expression: '0 * * * *' }),
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'stale-entrypoint-snapshot',
        message: expect.stringMatching(new RegExp(`${kind}.*regenerate`, 's')),
      }),
    ]);
  });

  it('rejects a directly dispatched cron job that declares guards', () => {
    const trigger = config({ triggers: { crons: ['0 3 * * *'] } });
    const guarded = { expression: '0 3 * * *', dialect: 'cloudflare', guards: true };
    expect(checkDeployment(trigger, 'staging', [row('schedule:cron', guarded)]).errors).toEqual([
      {
        code: 'scheduled-job-guards',
        message: expect.stringMatching(
          /"Jobs#run" declares @UseGuards, but guards do not run for directly dispatched scheduled jobs — use ScheduleModule\.forRoot\(\{ dispatch: \{ kind: 'signed', \.\.\. \} \}\) or remove the guard/,
        ),
      },
    ]);
    expect(
      checkDeployment(trigger, 'staging', [
        row('schedule:cron', { ...guarded, dispatch: 'signed' }),
      ]).errors,
    ).toEqual([]);
  });

  it('checks the guards of scheduled jobs in an actual application', async () => {
    class Allow {
      canActivate(): boolean {
        return true;
      }
    }
    @Injectable()
    @UseGuards(Allow)
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {}
    }
    @Injectable()
    class Open {
      @Cron('0 4 * * *', { dialect: 'cloudflare' })
      early() {}
    }
    /* oxlint-disable typescript/no-extraneous-class -- The decorated class is the module's identity. */
    @Module({ providers: [Jobs, Open] })
    class DirectModule {}
    @Module({
      imports: [
        ScheduleModule.forRoot({
          dispatch: { kind: 'signed', target: () => ({ path: '/jobs' }) },
        }),
      ],
      providers: [Jobs, Open],
    })
    class SignedModule {}
    /* oxlint-enable typescript/no-extraneous-class */
    const trigger = config({ triggers: { crons: ['0 3 * * *', '0 4 * * *'] } });
    for (const [root, codes] of [
      [DirectModule, ['scheduled-job-guards']],
      [SignedModule, []],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one application at a time
      const app = await VelaFactory.create(root, { diagnostics: 'silent' });
      try {
        const snapshot = JSON.parse(JSON.stringify(collectEntrypoints(app)));
        expect(
          checkDeployment(trigger, 'staging', snapshot).errors.map((error) => error.code),
        ).toEqual(codes);
      } finally {
        // eslint-disable-next-line no-await-in-loop -- one application at a time
        await app.close();
      }
    }
  });

  it('does not deduplicate multiple handlers into a false trigger mismatch', () => {
    const result = checkDeployment(config({ triggers: { crons: ['0 * * * *'] } }), 'staging', [
      row('schedule:cron', { expression: '0 * * * *', dialect: 'cloudflare' }),
      row('schedule:cron', { expression: '0 * * * *', methodName: 'other' }),
    ]);
    expect(result.errors).toEqual([]);
  });
});
