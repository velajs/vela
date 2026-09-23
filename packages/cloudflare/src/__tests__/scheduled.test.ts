import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Cron,
  Inject,
  Injectable,
  Interval,
  MetadataRegistry,
  Module,
  SCHEDULE_INVOCATION_SEED,
  Scope,
  UseGuards,
  VelaFactory,
  defineProvider,
  invokeScheduledJob,
  parseCronMetadata,
  type CanActivate,
  type CronInvocation,
  type ScheduleInvocation,
} from '@velajs/vela';
import { Test } from '@velajs/testing';
import * as cloudflare from '../index';
import { cloudflareAdapter, createCloudflareApp } from '../cloudflare-factory';
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
afterEach(() => {
  vi.restoreAllMocks();
});

// A job that injects the trigger and declares no scope of its own.
function defineReports(seen: CloudflareScheduledEvent[]) {
  @Injectable()
  class Reports {
    constructor(@Inject(CLOUDFLARE_SCHEDULED_EVENT) readonly trigger: CloudflareScheduledEvent) {}
    @Cron('30 2 * * *', { dialect: 'cloudflare' })
    nightly() {
      seen.push(this.trigger);
    }
  }
  /* oxlint-disable typescript/no-extraneous-class -- The decorated class is the module's identity. */
  @Module({ providers: [Reports] })
  class AppModule {}
  /* oxlint-enable typescript/no-extraneous-class */
  return { Reports, AppModule };
}

const nightlyInvocation = (): CronInvocation => ({
  kind: 'cron',
  expression: '30 2 * * *',
  scheduledTime: Date.UTC(2024, 0, 8, 2, 30),
  signal: new AbortController().signal,
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

  it('seeds a synthetic trigger event for cron jobs fired outside a trigger', async () => {
    const seen: CloudflareScheduledEvent[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Jobs {
      constructor(@Inject(CLOUDFLARE_SCHEDULED_EVENT) readonly event: CloudflareScheduledEvent) {}
      @Cron('30 2 * * *', { dialect: 'cloudflare' })
      nightly(tick: CronInvocation) {
        seen.push(this.event);
        this.event.noRetry();
        return tick.expression;
      }
    }
    @Module({ providers: [Jobs] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { adapters: [cloudflareAdapter({ env })] });
    try {
      const container = app.getContainer();
      expect(container.has(SCHEDULE_INVOCATION_SEED)).toBe(true);
      const seed = container.resolve(SCHEDULE_INVOCATION_SEED);
      const [entry] = app.entrypoints.ofKind('schedule:cron', parseCronMetadata);
      const invocation: CronInvocation = {
        kind: 'cron',
        expression: '30 2 * * *',
        scheduledTime: Date.UTC(2024, 0, 8, 2, 30),
        signal: new AbortController().signal,
      };
      await invokeScheduledJob(container, entry!, invocation, {
        seed: (scope) => seed(scope, invocation),
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        cron: '30 2 * * *',
        scheduledTime: invocation.scheduledTime,
      });
      expect(Object.isFrozen(seen[0])).toBe(true);
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

  it('refuses a guarded job on its trigger and still runs its siblings', async () => {
    const ran: string[] = [];
    const report = vi.fn();
    class Allow implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }
    @Injectable()
    @UseGuards(Allow)
    class Guarded {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        ran.push('guarded');
      }
    }
    @Injectable()
    class Plain {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        ran.push('plain');
      }
    }
    @Module({
      providers: [Guarded, Plain, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class AppModule {}
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await createCloudflareApp(AppModule, { env });
    try {
      await expect(app.scheduled({ cron: '0 3 * * *' }, env, context)).rejects.toThrow(
        /Guarded\.nightly declares @UseGuards, but guards do not run for directly dispatched scheduled jobs/,
      );
      expect(ran).toEqual(['plain']);
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/remove the guard/) }),
        expect.objectContaining({ edge: 'schedule', source: 'Guarded.nightly' }),
      );
    } finally {
      await app.close();
    }
  });

  describe('in a container the Cloudflare adapter did not configure', () => {
    it('boots the plain factory the CLI uses and keeps the job request-scoped', async () => {
      const seen: CloudflareScheduledEvent[] = [];
      const { Reports, AppModule } = defineReports(seen);
      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
      try {
        const container = app.getContainer();
        expect(container.getResolvedScope(Reports)).toBe(Scope.REQUEST);
        expect(() => app.get(CLOUDFLARE_SCHEDULED_EVENT)).toThrow('scheduled-event');
        const [entry] = app.entrypoints.ofKind('schedule:cron', parseCronMetadata);
        const trigger = Object.freeze({ cron: '30 2 * * *', scheduledTime: 1, noRetry() {} });
        await invokeScheduledJob(container, entry!, nightlyInvocation(), {
          seed: (scope) => scope.setRequestInstance(CLOUDFLARE_SCHEDULED_EVENT, trigger),
        });
        expect(seen).toEqual([trigger]);
        await expect(invokeScheduledJob(container, entry!, nightlyInvocation())).rejects.toThrow(
          'CLOUDFLARE_SCHEDULED_EVENT can only be resolved inside a scheduled invocation',
        );
      } finally {
        await app.close();
      }
    });

    it('compiles a testing module around the job', async () => {
      const { Reports, AppModule } = defineReports([]);
      const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      try {
        expect(() => module.get(Reports)).toThrow('request-scoped');
        await expect(module.resolveInRequest(Reports)).rejects.toThrow(
          'CLOUDFLARE_SCHEDULED_EVENT can only be resolved inside a scheduled invocation',
        );
      } finally {
        await module.close();
      }
    });
  });

  it('removes the Cloudflare-only cron decorator and its handler types', () => {
    expect(Object.keys(cloudflare)).not.toContain('Scheduled');
    expect(Object.keys(cloudflare)).not.toContain('parseScheduledMetadata');
    expect(Object.keys(cloudflare)).toContain('CLOUDFLARE_SCHEDULED_EVENT');
    expectTypeOf<ScheduledEvent>().toEqualTypeOf<cloudflare.ScheduledEvent>();
  });
});
