import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  EXECUTION_LIFETIME,
  Global,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Post,
  Scope,
  URL_SIGNING_SECRET,
  UseFilters,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type ExecutionLifetime,
  type NestInterceptor,
  type VelaApplication,
} from '../index';
import { SignedInvocation } from '../dispatch/index';
import type { Entrypoint } from '../module-kit';
import { APP_EXCEPTION_HANDLER } from '../pipeline/tokens';
import {
  Cron,
  Interval,
  ScheduleModule,
  type CronMetadata,
  type IntervalMetadata,
  type ScheduleInvocation,
  type ScheduleJobRef,
} from '../schedule';
import {
  cronDialectAmbiguity,
  invokeScheduledJob,
  parseCronMetadata,
  parseIntervalMetadata,
  type InvokeScheduledJobOptions,
} from '../module-kit';
import { ScheduleNodeModule } from '../schedule-node';
import { Process, Processor } from '../queue';

const applications: VelaApplication[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(applications.splice(0).map((app) => app.close()));
});

async function create(root: Parameters<typeof VelaFactory.create>[0]) {
  const app = await VelaFactory.create(root, { diagnostics: 'silent' });
  applications.push(app);
  return app;
}

function cronEntry(app: VelaApplication, methodName: string) {
  const entry = app.entrypoints
    .ofKind('schedule:cron', parseCronMetadata)
    .find((candidate) => candidate.meta.methodName === methodName);
  if (!entry) throw new Error(`No cron entrypoint for ${methodName}`);
  return entry;
}

function tick(expression: string, signal = new AbortController().signal): ScheduleInvocation {
  return { kind: 'cron', expression, scheduledTime: Date.UTC(2024, 0, 8, 3), signal };
}

describe('invokeScheduledJob', () => {
  it('runs the job in a fresh invocation scope of its owning module with only the invocation', async () => {
    const PLATFORM = new InjectionToken<string>('synthetic platform event');
    const calls: Array<{ args: unknown[]; job: Jobs; platform: string }> = [];
    const disposed: Jobs[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Jobs {
      constructor(
        @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
        @Inject(PLATFORM) readonly platform: string,
      ) {}
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly(...args: unknown[]) {
        calls.push({ args, job: this, platform: this.platform });
      }
      dispose() {
        disposed.push(this);
      }
    }
    @Module({
      providers: [
        Jobs,
        defineProvider(PLATFORM, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: () => 'unseeded',
        }),
      ],
    })
    class Root {}
    const app = await create(Root);
    const invocation = tick('0 3 * * *');
    const options: InvokeScheduledJobOptions = {
      seed: (scope) => scope.setRequestInstance(PLATFORM, 'seeded'),
    };

    await invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), invocation, options);
    await invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), invocation);

    expect(calls.map((call) => call.args)).toEqual([[invocation], [invocation]]);
    expect(calls[0]?.args[0]).toBe(invocation);
    expect(calls.map((call) => call.platform)).toEqual(['seeded', 'unseeded']);
    expect(calls[0]?.job).not.toBe(calls[1]?.job);
    expect(calls[0]?.job.lifetime.signal).toBe(invocation.signal);
    expect(calls.every((call) => !call.job.lifetime.active)).toBe(true);
    expect(disposed).toEqual(calls.map((call) => call.job));
  });

  it('applies neither global guards nor declared interceptors and filters to a direct job', async () => {
    const seen: string[] = [];
    class Deny implements CanActivate {
      canActivate(): boolean {
        seen.push('guard');
        return false;
      }
    }
    class Spy implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: { handle(): Promise<unknown> }) {
        seen.push('interceptor');
        return next.handle();
      }
    }
    class Claim {
      catch(): void {
        seen.push('filter');
      }
    }
    @Injectable()
    @UseInterceptors(Spy)
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      @UseFilters(Claim)
      nightly() {
        seen.push('job');
      }
    }
    @Module({ providers: [Jobs, defineProvider(APP_GUARD, { useClass: Deny })] })
    class Root {}
    const app = await create(Root);

    await invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), tick('0 3 * * *'));

    expect(seen).toEqual(['job']);
  });

  describe('a direct job that declares guards', () => {
    class Allow implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }
    // The same job with its guard declared on the class, method or module.
    // Module-level components apply to the controllers a module declares.
    function guardedRoot(on: 'class' | 'method' | 'module', seen: string[], report: () => void) {
      const onClass = on === 'class' ? UseGuards(Allow) : () => {};
      const onMethod = on === 'method' ? UseGuards(Allow) : () => {};
      const onModule = on === 'module' ? UseGuards(Allow) : () => {};
      @Controller('jobs')
      @onClass
      class Jobs {
        @Cron('0 3 * * *', { dialect: 'cloudflare' })
        @onMethod
        nightly() {
          seen.push('job');
        }
        @Interval(60_000)
        @onMethod
        poll() {
          seen.push('poll');
        }
      }
      @onModule
      @Module({
        controllers: [Jobs],
        providers: [defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
      })
      class Root {}
      return Root;
    }

    it.each(['class', 'method', 'module'] as const)(
      'refuses to run when the guard is declared on its %s, and reports why',
      async (on) => {
        const seen: string[] = [];
        const report = vi.fn();
        const app = await create(guardedRoot(on, seen, report));
        const refusal =
          /Jobs\.nightly declares @UseGuards, but guards do not run for directly dispatched scheduled jobs — use ScheduleModule\.forRoot\(\{ dispatch: \{ kind: 'signed', \.\.\. \} \}\) or remove the guard/;

        await expect(
          invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), tick('0 3 * * *')),
        ).rejects.toThrow(refusal);
        const [interval] = app.entrypoints.ofKind('schedule:interval', parseIntervalMetadata);
        await expect(
          invokeScheduledJob(app.getContainer(), interval!, {
            kind: 'interval',
            ms: 60_000,
            scheduledTime: Date.UTC(2024, 0, 8, 3),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(/Jobs\.poll declares @UseGuards/);

        expect(seen).toEqual([]);
        expect(report).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringMatching(refusal) }),
          expect.objectContaining({ edge: 'schedule', source: 'Jobs.nightly' }),
        );
      },
    );

    it('is refused on every tick of the Node executor', async () => {
      vi.useFakeTimers();
      try {
        const seen: string[] = [];
        const report = vi.fn();
        @Injectable()
        @UseGuards(Allow)
        class Jobs {
          @Interval(1000)
          poll() {
            seen.push('poll');
          }
        }
        @Module({
          imports: [ScheduleNodeModule],
          providers: [Jobs, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
        })
        class Root {}
        const app = await create(Root);

        await vi.advanceTimersByTimeAsync(2000);
        await app.close();

        expect(seen).toEqual([]);
        expect(report).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringMatching(/Jobs\.poll declares @UseGuards, but guards do not run/),
          }),
          expect.objectContaining({ edge: 'schedule', source: 'Jobs.poll' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reports a failure once on the schedule edge and rethrows it', async () => {
    const report = vi.fn();
    const failure = new Error('nightly failed');
    @Injectable()
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        throw failure;
      }
    }
    @Module({
      providers: [Jobs, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class Root {}
    const app = await create(Root);

    await expect(
      invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), tick('0 3 * * *')),
    ).rejects.toBe(failure);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ edge: 'schedule', source: 'Jobs.nightly' }),
    );
  });

  it('treats its own abort reason as cancellation rather than a failure', async () => {
    const report = vi.fn();
    let calls = 0;
    @Injectable()
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        calls++;
      }
    }
    @Module({
      providers: [Jobs, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class Root {}
    const app = await create(Root);
    const controller = new AbortController();
    controller.abort();

    await expect(
      invokeScheduledJob(
        app.getContainer(),
        cronEntry(app, 'nightly'),
        tick('0 3 * * *', controller.signal),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('re-enters the signed route through InternalDispatcher so global guards run', async () => {
    const seen: string[] = [];
    const jobs: ScheduleJobRef[] = [];
    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'schedule-invoke-secret' })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}
    class GlobalGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        seen.push(`guard:${context.getType()}`);
        return true;
      }
    }
    @Controller('/jobs')
    class JobsController {
      @Post('nightly')
      @SignedInvocation()
      nightly(): { ok: boolean } {
        seen.push('route');
        return { ok: true };
      }
    }
    class Deny implements CanActivate {
      canActivate(): boolean {
        seen.push('job guard');
        return false;
      }
    }
    // Signed dispatch never calls the job directly, so its guard is no refusal.
    @Injectable()
    @UseGuards(Deny)
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        seen.push('direct');
      }
    }
    @Module({
      imports: [
        SecretModule,
        ScheduleModule.forRoot({
          dispatch: {
            kind: 'signed',
            target: (job) => {
              jobs.push(job);
              return { path: '/jobs/nightly' };
            },
          },
        }),
      ],
      controllers: [JobsController],
      providers: [Jobs, defineProvider(APP_GUARD, { useClass: GlobalGuard })],
    })
    class Root {}
    const app = await create(Root);

    await invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), tick('0 3 * * *'));

    expect(seen).toEqual(['guard:http', 'route']);
    expect(jobs).toEqual([{ kind: 'cron', expression: '0 3 * * *', methodName: 'nightly' }]);
  });

  it('accepts the owner-bearing entries ScheduleRegistry and app.entrypoints expose', () => {
    type Job = Parameters<typeof invokeScheduledJob>[1];
    expectTypeOf<Entrypoint<CronMetadata>>().toExtend<Job>();
    expectTypeOf<Entrypoint<IntervalMetadata>>().toExtend<Job>();
    expectTypeOf(invokeScheduledJob).returns.toEqualTypeOf<Promise<void>>();
  });
});

describe('cron dialect ambiguity', () => {
  it.each([
    ['0 9 * * 1', 'weekday'],
    ['0 9 * * 1-5', 'weekday'],
    ['0 9 1 * MON', 'day-of-month'],
    ['0 9 L * FRI', 'day-of-month'],
  ])('explains why %s means different days by runtime', (expression, field) => {
    expect(cronDialectAmbiguity({ expression })).toContain(field);
    expect(cronDialectAmbiguity({ expression, dialect: 'cloudflare' })).toBeUndefined();
    expect(cronDialectAmbiguity({ expression, dialect: 'unix' })).toBeUndefined();
  });

  it("attributes the rule that both restricted day fields must match to Vela's unix dialect", () => {
    const reason = cronDialectAmbiguity({ expression: '0 9 1 * MON' });
    expect(reason).toMatch(/Vela's unix dialect requires/);
    expect(reason).toMatch(/Cloudflare, like standard crontab, fires when either/);
  });

  it.each(['0 9 * * *', '*/5 * * * *', '0 9 * * MON-FRI', '0 9 15 * *'])(
    'accepts %s, which means the same on every runtime',
    (expression) => {
      expect(cronDialectAmbiguity({ expression })).toBeUndefined();
    },
  );

  it('warns once per declaration from the Node executor and throws only in throw mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A UTC process isolates the dialect report from the time-zone report.
    const zone = process.env.TZ;
    process.env.TZ = 'UTC';
    vi.useFakeTimers();
    try {
      @Injectable()
      class Jobs {
        @Cron('0 7 * * 1')
        weekly() {}
      }
      @Module({ imports: [ScheduleNodeModule], providers: [Jobs] })
      class Root {}

      const first = await VelaFactory.create(Root);
      const second = await VelaFactory.create(Root);
      await Promise.all([first.close(), second.close()]);
      expect(warn).toHaveBeenCalledOnce();
      const warning = String(warn.mock.calls[0]?.[0]);
      expect(warning).toMatch(/'0 7 \* \* 1'.*Jobs\.weekly.*no dialect/);
      // A portable job declares the Cloudflare dialect; unix is only for Node-only jobs.
      expect(warning).toMatch(
        /declare \{ dialect: 'cloudflare' \}.*\{ dialect: 'unix' \} only for/,
      );

      await expect(VelaFactory.create(Root, { diagnostics: 'throw' })).rejects.toThrow(
        /Jobs\.weekly declares no dialect/,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreTimeZone(zone);
    }
  });
});

function restoreTimeZone(zone: string | undefined): void {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

describe('Node executor time zone', () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env.TZ;
  });
  afterEach(() => {
    restoreTimeZone(zone);
  });

  function jobs() {
    @Injectable()
    class Jobs {
      @Cron('0 9 * * *')
      morning() {}
      @Cron('0 10 * * *', { timeZone: 'UTC' })
      utc() {}
      @Cron('0 11 * * *', { dialect: 'cloudflare' })
      cloudflare() {}
      @Cron('0 12 * * *', { timeZone: 'local' })
      local() {}
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Jobs] })
    class Root {}
    return Root;
  }

  it('warns once when a bare @Cron runs at local time under Node but in UTC on Workers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TZ = 'America/New_York';
    const Root = jobs();

    const first = await VelaFactory.create(Root);
    const second = await VelaFactory.create(Root);
    await Promise.all([first.close(), second.close()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /'0 9 \* \* \*'.*Jobs\.morning.*local time \(America\/New_York\).*UTC/,
    );
    await expect(VelaFactory.create(Root, { diagnostics: 'throw' })).rejects.toThrow(
      /Jobs\.morning declares neither dialect nor timeZone/,
    );
  });

  it('stays quiet when the process runs in UTC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TZ = 'UTC';

    const app = await VelaFactory.create(jobs(), { diagnostics: 'throw' });
    await app.close();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('scheduled job components', () => {
  it('warns once that guards, interceptors and filters declared for a job do not run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class Deny implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    class Spy implements NestInterceptor {
      intercept(_context: ExecutionContext, next: { handle(): Promise<unknown> }) {
        return next.handle();
      }
    }
    class Claim {
      catch(): void {}
    }
    @Injectable()
    @UseGuards(Deny)
    class Guarded {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {}
    }
    @Injectable()
    class Decorated {
      @Interval(60_000)
      @UseInterceptors(Spy)
      @UseFilters(Claim)
      poll() {}
      @Cron('0 4 * * *', { dialect: 'cloudflare' })
      plain() {}
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Guarded, Decorated] })
    class Root {}

    const first = await VelaFactory.create(Root);
    const second = await VelaFactory.create(Root);
    await Promise.all([first.close(), second.close()]);

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(
      /Guarded\.nightly declares @UseGuards.*do not run.*one that declares guards refuses to run.*signed/,
    );
    expect(messages[1]).toMatch(/Decorated\.poll declares @UseInterceptors and @UseFilters/);
    expect(messages[1]).not.toMatch(/refuses/);
    await expect(VelaFactory.create(Root, { diagnostics: 'throw' })).rejects.toThrow(
      /Guarded\.nightly declares @UseGuards/,
    );
  });
});

describe('request-scoped entrypoint owners', () => {
  it('lists request-scoped jobs and processors at bootstrap without a skipped warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const EVENT = new InjectionToken<string>('synthetic scheduled event');
    const ran: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Jobs {
      constructor(@Inject(EVENT) readonly event: string) {}
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      nightly() {
        ran.push(this.event);
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    @Processor('scoped')
    class Scoped {
      @Process() handle() {}
    }
    @Module({
      providers: [
        Jobs,
        Scoped,
        defineProvider(EVENT, { scope: Scope.REQUEST, inject: [], useFactory: () => 'event' }),
      ],
    })
    class Root {}

    const app = await VelaFactory.create(Root);
    applications.push(app);

    expect(warn).not.toHaveBeenCalled();
    expect(cronEntry(app, 'nightly').instance).toBeUndefined();
    expect(app.entrypoints.ofKind('queue').map((entry) => entry.token)).toEqual([Scoped]);
    await invokeScheduledJob(app.getContainer(), cronEntry(app, 'nightly'), tick('0 3 * * *'));
    expect(ran).toEqual(['event']);
  });
});
