import { describe, expect, it } from 'vitest';
import { Cron, Injectable, Module, VelaFactory } from '@velajs/vela';
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
    @Injectable()
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

  it('does not deduplicate multiple handlers into a false trigger mismatch', () => {
    const result = checkDeployment(config({ triggers: { crons: ['0 * * * *'] } }), 'staging', [
      row('schedule:cron', { expression: '0 * * * *', dialect: 'cloudflare' }),
      row('schedule:cron', { expression: '0 * * * *', methodName: 'other' }),
    ]);
    expect(result.errors).toEqual([]);
  });
});
