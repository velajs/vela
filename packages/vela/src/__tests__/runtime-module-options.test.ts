import { describe, expect, it, vi } from 'vitest';
import { ENV, ErrorsModule, Module, VelaFactory, defineErrorCatalog } from '../index';
import { ERROR_CATALOG } from '../pipeline/tokens';
import { LiveModule, PresenceService } from '../live';
import { ScheduleModule, SCHEDULE_DISPATCH } from '../schedule';
import { getSignedScheduleRunner } from '../schedule/schedule.signed';
import {
  WebSocketModule,
  WS_ROOM_REGISTRY,
  WS_SYNC_DRIVER,
  local,
  InMemoryRoomRegistry,
} from '../websocket';

describe('application-owned runtime module options', () => {
  it('constructs and binds fresh WebSocket drivers and registries from async options per app', async () => {
    const sync = vi.fn(async () => local());
    const registry = vi.fn(async () => new InMemoryRoomRegistry());
    @Module({
      imports: [WebSocketModule.forRootAsync({ useFactory: async () => ({ sync, registry }) })],
    })
    class App {}
    const first = await VelaFactory.create(App);
    const second = await VelaFactory.create(App);
    try {
      expect(first.get(WS_SYNC_DRIVER)).not.toBe(second.get(WS_SYNC_DRIVER));
      expect(first.get(WS_ROOM_REGISTRY)).not.toBe(second.get(WS_ROOM_REGISTRY));
      expect(sync).toHaveBeenCalledTimes(2);
      expect(registry).toHaveBeenCalledTimes(2);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it.each([
    ['driver', 'instance'],
    ['registry', 'instance'],
    ['driver', 'factory'],
    ['registry', 'factory'],
  ] as const)(
    'rejects cross-application reuse of a WebSocket %s supplied as an %s',
    async (kind, source) => {
      const driver = local();
      const registry = new InMemoryRoomRegistry();
      @Module({
        imports: [
          WebSocketModule.forRoot(
            kind === 'driver'
              ? { sync: source === 'factory' ? () => driver : driver }
              : { registry: source === 'factory' ? () => registry : registry },
          ),
        ],
      })
      class App {}
      const first = await VelaFactory.create(App);
      try {
        expect(first.get(kind === 'driver' ? WS_SYNC_DRIVER : WS_ROOM_REGISTRY)).toBe(
          kind === 'driver' ? driver : registry,
        );
        await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
          /already assigned to an application/,
        );
      } finally {
        await first.close();
      }
    },
  );

  it('rejects rebinding one application sync driver to a different registry', async () => {
    const driver = local();
    @Module({
      imports: [
        WebSocketModule.forRoot({ sync: driver }),
        WebSocketModule.forRoot({ key: 'second', sync: driver }),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
      /already bound to a different room registry/,
    );
  });

  it('resolves presence TTL per application while keeping resolver registration structural', async () => {
    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRootAsync({
          presence: true,
          inject: [ENV],
          useFactory: (env) => ({ presenceOptions: { ttlMs: Number(Reflect.get(env, 'TTL')) } }),
        }),
      ],
    })
    class App {}
    const first = await VelaFactory.create(App, { env: { TTL: 10 } });
    const second = await VelaFactory.create(App, { env: { TTL: 1000 } });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const short = first.get(PresenceService),
        long = second.get(PresenceService);
      short.beat('/rooms/:id', 'one', 'client');
      long.beat('/rooms/:id', 'one', 'client');
      clock.mockReturnValue(now + 20);
      expect(short.roster('/rooms/:id', 'one')).toEqual([]);
      expect(long.roster('/rooms/:id', 'one')).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await first.close();
      await second.close();
    }
  });

  it('resolves and binds signed schedule policies within each application', async () => {
    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          inject: [ENV],
          useFactory: (env) => ({
            dispatch: {
              kind: 'signed',
              target: () => ({ path: String(Reflect.get(env, 'TARGET')) }),
            },
          }),
        }),
      ],
    })
    class App {}
    const first = await VelaFactory.create(App, { env: { TARGET: '/one' } });
    const second = await VelaFactory.create(App, { env: { TARGET: '/two' } });
    try {
      const a = first.get(SCHEDULE_DISPATCH),
        b = second.get(SCHEDULE_DISPATCH);
      if (a.kind !== 'signed' || b.kind !== 'signed') throw new Error('Expected signed policies.');
      expect(a).not.toBe(b);
      expect(a.target({ kind: 'interval', ms: 1, methodName: 'tick' })).toEqual({ path: '/one' });
      expect(b.target({ kind: 'interval', ms: 1, methodName: 'tick' })).toEqual({ path: '/two' });
      expect(getSignedScheduleRunner(a)).toEqual(expect.any(Function));
      expect(getSignedScheduleRunner(b)).toEqual(expect.any(Function));
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rejects conflicting asynchronous schedule policies even under explicit keys', async () => {
    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          key: 'one',
          useFactory: () => ({ dispatch: { kind: 'direct' } }),
        }),
        ScheduleModule.forRootAsync({
          key: 'two',
          useFactory: () => ({ dispatch: { kind: 'signed', target: () => ({ path: '/two' }) } }),
        }),
      ],
    })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
      /different dispatch policies/,
    );
  });

  it('composes async error catalogs per environment and still rejects duplicate codes', async () => {
    @Module({
      imports: [
        ErrorsModule.forRootAsync({
          inject: [ENV],
          useFactory: (env) => ({
            catalogs: [
              defineErrorCatalog({
                example: { status: 409, title: String(Reflect.get(env, 'TITLE')) },
              }),
            ],
          }),
        }),
      ],
    })
    class App {}
    const first = await VelaFactory.create(App, { env: { TITLE: 'First' } });
    const second = await VelaFactory.create(App, { env: { TITLE: 'Second' } });
    try {
      expect(first.get(ERROR_CATALOG).get('example')?.title).toBe('First');
      expect(second.get(ERROR_CATALOG).get('example')?.title).toBe('Second');
    } finally {
      await first.close();
      await second.close();
    }
    const catalog = defineErrorCatalog({ duplicate: { status: 409, title: 'Duplicate' } });
    @Module({
      imports: [
        ErrorsModule.forRootAsync({ useFactory: () => ({ catalogs: [catalog, catalog] }) }),
      ],
    })
    class Duplicate {}
    await expect(VelaFactory.create(Duplicate)).rejects.toThrow(/duplicate error code/);
  });
});
