import { describe, expect, expectTypeOf, it } from 'vitest';
import { Cron, Injectable, InjectionToken, Module } from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import {
  Scheduled,
  getScheduledMetadata,
  parseScheduledMetadata,
  type ScheduledController,
  type ScheduledContext,
  type ScheduledHandler,
} from '../decorators/scheduled';

describe('native scheduled metadata', () => {
  it('validates the native dialect while retaining exact trigger strings', () => {
    class NativeJob {
      @Scheduled('0  9 * * mon-fri')
      run() {}
    }
    expect(getScheduledMetadata(NativeJob)).toEqual([
      { cron: '0  9 * * mon-fri', methodName: 'run' },
    ]);
    expect(() => Scheduled('0 0 * * 0')).toThrow('Invalid Cloudflare cron');
    expect(() => Scheduled('0x10 0 * * *')).toThrow('Invalid Cloudflare cron');
    expect(parseScheduledMetadata({ cron: '59 23 LW * *', methodName: 'run' }).cron).toBe(
      '59 23 LW * *',
    );
    expect(() => parseScheduledMetadata({ cron: 'not-cron', methodName: 'run' })).toThrow();
  });

  it('keeps class metadata independent and returns defensive copies', () => {
    class Parent {
      @Scheduled('0 * * * *')
      hourly() {}
    }
    class Child extends Parent {
      @Scheduled('0 0 * * *')
      daily() {}
    }
    expect(getScheduledMetadata(Parent)).toHaveLength(1);
    expect(getScheduledMetadata(Child)).toEqual([{ cron: '0 0 * * *', methodName: 'daily' }]);
    const copy = getScheduledMetadata(Parent);
    copy[0]!.cron = 'changed';
    expect(getScheduledMetadata(Parent)[0]?.cron).toBe('0 * * * *');
  });

  it('preserves native controller identity, receiver and exact matching for both decorators', async () => {
    const env = { name: 'native' };
    const token = new InjectionToken<typeof env>('scheduled metadata env');
    let calls = 0;
    let noRetry = false;
    const event: ScheduledController = {
      cron: '0  9 * * MON',
      scheduledTime: Date.UTC(2024, 0, 8, 9),
      noRetry() {
        expect(this).toBe(event);
        noRetry = true;
      },
    };
    @Injectable()
    class Jobs {
      @Scheduled('0  9 * * MON')
      native(controller: ScheduledController, bindings: typeof env, context: ScheduledContext) {
        expect(controller).toBe(event);
        expect(bindings).toBe(env);
        expectTypeOf(context.waitUntil).toEqualTypeOf<(promise: Promise<unknown>) => void>();
        controller.noRetry();
        calls++;
      }
      @Cron('0  9 * * MON')
      core(controller: ScheduledController) {
        expect(controller).toBe(event);
        calls++;
      }
    }
    expectTypeOf<Jobs['native']>().toExtend<ScheduledHandler<typeof env>>();
    @Module({ providers: [Jobs] })
    class Root {}
    const app = await createCloudflareApp(Root, { env, envToken: token });
    try {
      await app.scheduled({ cron: '0 9 * * MON' }, env, { waitUntil() {} });
      expect(calls).toBe(0);
      await app.scheduled(event, env, { waitUntil() {} });
      expect(calls).toBe(2);
      expect(noRetry).toBe(true);
      expect(app.entrypoints.ofKind('schedule:cron')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
