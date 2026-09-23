import { describe, expect, it } from 'vitest';
import { Cron, Injectable, Module, VelaFactory } from '@velajs/vela';
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
  it('checks module queue mappings, producers and service bindings in the selected environment', () => {
    const snapshot = [
      row('cf:queue:module', { queueName: 'tasks-staging', logicalQueue: 'tasks' }),
      row('cf:queue:producer', { logicalQueue: 'tasks', binding: 'TASKS' }),
      row('rpc:client', { name: 'catalog', binding: 'CATALOG' }),
    ];
    const valid = config({
      queues: {
        producers: [{ binding: 'TASKS', queue: 'tasks-staging' }],
        consumers: [{ queue: 'tasks-staging' }],
      },
      services: [{ binding: 'CATALOG', service: 'catalog-staging' }],
    });
    expect(checkDeployment(valid, 'staging', snapshot).errors).toEqual([]);
    expect(
      checkDeployment(config(), 'staging', snapshot)
        .errors.map((x) => x.code)
        .sort(),
    ).toEqual(['missing-queue-consumer', 'missing-queue-producer', 'missing-service-binding']);
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
