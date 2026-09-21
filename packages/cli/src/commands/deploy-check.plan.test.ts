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
    (kind === 'cf:vela-cron' || kind === 'schedule:cron') &&
    typeof meta === 'object' &&
    meta !== null
      ? { methodName: 'run', ...meta }
      : meta,
});

describe('deployment alignment', () => {
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
    @Module({ providers: [Jobs] })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Decorated module identity is the fixture.
    class AppModule {}
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
        row('cf:scheduled', JSON.stringify({ cron: '0 * * * *', methodName: 'run' })),
        row('cf:queue', { queueName: 'jobs' }),
        row('websocket', { options: { binding: 'ROOM' }, dispatcher: '[WsDispatcher]' }),
      ],
    );
    expect(result.status).toBe('passed');
  });

  it('accepts Cloudflare Sunday and Quartz-style extensions with the shared parser', () => {
    const crons = ['0 0 * * 1', '59 23 LW * *', '0 18 * * 6L', '0 0 * * MON#2'];
    expect(
      checkDeployment(
        config({ triggers: { crons } }),
        'staging',
        crons.map((expression) => row('cf:vela-cron', { expression })),
      ).errors,
    ).toEqual([]);
  });

  it('does not silently normalize differing exact trigger strings', () => {
    const result = checkDeployment(config({ triggers: { crons: ['0 0 * * SUN'] } }), 'staging', [
      row('cf:scheduled', { cron: '0 0 * * 1' }),
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
          row('cf:scheduled', { cron }),
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
        row('cf:scheduled', { cron: 4 }),
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

  it('does not deduplicate multiple handlers into a false trigger mismatch', () => {
    const result = checkDeployment(config({ triggers: { crons: ['0 * * * *'] } }), 'staging', [
      row('cf:scheduled', { cron: '0 * * * *' }),
      row('cf:vela-cron', { expression: '0 * * * *' }),
    ]);
    expect(result.errors).toEqual([]);
  });
});
