import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  Cron,
  Inject,
  Injectable,
  Interval,
  MetadataRegistry,
  Module,
  Scope,
  type ScheduleInvocation,
} from '@velajs/vela';
import * as cloudflare from '../index';
import { createCloudflareApp } from '../cloudflare-factory';
import {
  CLOUDFLARE_SCHEDULED_EVENT,
  type CloudflareScheduledEvent,
  type ScheduledEvent,
} from '../scheduled-event';

const env = {};
const context = { waitUntil() {} };

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('@Cron on Workers scheduled triggers', () => {
  it('runs the jobs whose expression is exactly the delivered trigger string', async () => {
    const calls: string[] = [];
    @Injectable()
    class Jobs {
      @Cron('0 * * * *', { dialect: 'cloudflare' })
      hourly() {
        calls.push('hourly');
      }
      @Cron('0 0 * * *')
      daily() {
        calls.push('daily');
      }
      @Cron('0  9 * * MON', { dialect: 'cloudflare' })
      spaced() {
        calls.push('spaced');
      }
      @Interval(60_000)
      every() {
        calls.push('interval');
      }
    }
    @Injectable()
    class Other {
      @Cron('0 * * * *', { dialect: 'cloudflare' })
      hourly() {
        calls.push('other');
      }
    }
    @Module({ providers: [Jobs, Other] })
    class AppModule {}
    const app = await createCloudflareApp(AppModule, { env });
    try {
      await app.scheduled({ cron: '0 * * * *' }, env, context);
      expect(calls.toSorted()).toEqual(['hourly', 'other']);
      await app.scheduled({ cron: '0 0 * * *' }, env, context);
      await app.scheduled({ cron: '0 9 * * MON' }, env, context);
      await app.scheduled({ cron: '*/5 * * * *' }, env, context);
      expect(calls.slice(2)).toEqual(['daily']);
      await app.scheduled({ cron: '0  9 * * MON' }, env, context);
      expect(calls.slice(3)).toEqual(['spaced']);
      expect(app.entrypoints.kinds()).not.toContain('cf:vela-cron');
      expect(app.entrypoints.kinds()).not.toContain('cf:scheduled');
    } finally {
      await app.close();
    }
  });

  it('passes only a ScheduleInvocation built from the native event', async () => {
    const calls: unknown[][] = [];
    @Injectable()
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly(...args: unknown[]) {
        calls.push(args);
      }
    }
    @Module({ providers: [Jobs] })
    class AppModule {}
    const app = await createCloudflareApp(AppModule, { env });
    try {
      const scheduledTime = Date.UTC(2024, 0, 8, 3);
      await app.scheduled({ cron: '0 3 * * *', scheduledTime, noRetry() {} }, env, context);
      const before = Date.now();
      await app.scheduled({ cron: '0 3 * * *' }, env, context);
      const after = Date.now();

      expect(calls.map((args) => args.length)).toEqual([1, 1]);
      const [first, second] = calls.map((args) => args[0] as ScheduleInvocation);
      expect(first).toMatchObject({ kind: 'cron', expression: '0 3 * * *', scheduledTime });
      expect(first?.signal.aborted).toBe(false);
      expect(second?.scheduledTime).toBeGreaterThanOrEqual(before);
      expect(second?.scheduledTime).toBeLessThanOrEqual(after);
      expect(Object.keys(first ?? {}).toSorted()).toEqual([
        'expression',
        'kind',
        'scheduledTime',
        'signal',
      ]);
    } finally {
      await app.close();
    }
  });

  it('exposes the native event and its bound noRetry through CLOUDFLARE_SCHEDULED_EVENT', async () => {
    const seen: CloudflareScheduledEvent[] = [];
    const receivers: unknown[] = [];
    const event = {
      cron: '0 3 * * *',
      scheduledTime: Date.UTC(2024, 0, 8, 3),
      noRetry(this: unknown) {
        receivers.push(this);
      },
    };
    @Injectable({ scope: Scope.REQUEST })
    class Jobs {
      constructor(@Inject(CLOUDFLARE_SCHEDULED_EVENT) readonly event: CloudflareScheduledEvent) {}
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        seen.push(this.event);
        const { noRetry } = this.event;
        noRetry();
      }
    }
    @Module({ providers: [Jobs] })
    class AppModule {}
    const app = await createCloudflareApp(AppModule, { env });
    try {
      await app.scheduled(event, env, context);
      await app.scheduled({ cron: '0 3 * * *' }, env, context);

      expect(seen[0]).toMatchObject({ cron: '0 3 * * *', scheduledTime: event.scheduledTime });
      expect(receivers).toEqual([event]);
      expect(seen[0]).not.toBe(seen[1]);
      expect(Object.isFrozen(seen[0])).toBe(true);
      expect(() => app.get(CLOUDFLARE_SCHEDULED_EVENT)).toThrow('scheduled');
    } finally {
      await app.close();
    }
  });

  it('aborts the invocation signal on close and waits for the job to settle', async () => {
    const events: string[] = [];
    const entered = Promise.withResolvers<void>();
    @Injectable()
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      async nightly(tick: ScheduleInvocation) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          tick.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        events.push('aborted');
        tick.signal.throwIfAborted();
      }
    }
    @Module({ providers: [Jobs] })
    class AppModule {}
    const app = await createCloudflareApp(AppModule, { env });
    const running = app.scheduled({ cron: '0 3 * * *' }, env, context);
    await entered.promise;
    await app.close();
    expect(events).toEqual(['aborted']);
    await expect(running).resolves.toBeUndefined();
  });

  it('removes the Cloudflare-only cron decorator and its handler types', () => {
    expect(Object.keys(cloudflare)).not.toContain('Scheduled');
    expect(Object.keys(cloudflare)).not.toContain('parseScheduledMetadata');
    expect(Object.keys(cloudflare)).toContain('CLOUDFLARE_SCHEDULED_EVENT');
    expectTypeOf<ScheduledEvent>().toEqualTypeOf<cloudflare.ScheduledEvent>();
  });
});
