import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  APP_GUARD,
  Controller,
  EXECUTION_LIFETIME,
  Global,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  Post,
  Scope,
  SignedInvocation,
  URL_SIGNING_SECRET,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type Entrypoint,
  type ExecutionContext,
  type ExecutionLifetime,
  type NestInterceptor,
  type VelaApplication,
} from '../index';
import { APP_EXCEPTION_HANDLER } from '../pipeline/tokens';
import {
  Cron,
  ScheduleModule,
  cronDialectAmbiguity,
  invokeScheduledJob,
  parseCronMetadata,
  type CronMetadata,
  type IntervalMetadata,
  type InvokeScheduledJobOptions,
  type ScheduleInvocation,
  type ScheduleJobRef,
} from '../schedule';
import { ScheduleNodeModule } from '../schedule-node';

const applications: VelaApplication[] = [];

beforeEach(() => {
  MetadataRegistry.clear();
});
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

  it('applies neither global nor scoped guards and interceptors to a direct job', async () => {
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
    @Injectable()
    @UseGuards(Deny)
    @UseInterceptors(Spy)
    class Jobs {
      @Cron('0 3 * * *', { dialect: 'cloudflare' })
      @UseGuards(Deny)
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
    @Injectable()
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

  it.each(['0 9 * * *', '*/5 * * * *', '0 9 * * MON-FRI', '0 9 15 * *'])(
    'accepts %s, which means the same on every runtime',
    (expression) => {
      expect(cronDialectAmbiguity({ expression })).toBeUndefined();
    },
  );

  it('warns once per declaration from the Node executor and throws only in throw mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/'0 7 \* \* 1'.*Jobs\.weekly.*no dialect/);

      await expect(VelaFactory.create(Root, { diagnostics: 'throw' })).rejects.toThrow(
        /Jobs\.weekly declares no dialect/,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
