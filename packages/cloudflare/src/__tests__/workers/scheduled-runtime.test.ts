// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
const { createExecutionContext, createScheduledController, waitOnExecutionContext, env } =
  cloudflareTest;
import { describe, expect, it, vi } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  APP_GUARD,
  Controller,
  EXECUTION_LIFETIME,
  Inject,
  InjectEnv,
  Injectable,
  Module,
  Post,
  Scope,
  UseGuards,
  VelaFactory,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type ExecutionLifetime,
  type VelaEnv,
} from '@velajs/vela';
import {
  Cron,
  Interval,
  ScheduleModule,
  parseCron,
  type CronInvocation,
  type ScheduleInvocation,
  type ScheduleJobRef,
} from '@velajs/vela/schedule';
import {
  SCHEDULE_INVOCATION_SEED,
  invokeScheduledJob,
  parseCronMetadata,
} from '@velajs/vela/module-kit';
import { SignedInvocation } from '@velajs/vela/dispatch';
import { cloudflareAdapter, createCloudflareWorker } from '../../cloudflare-factory';
import { CLOUDFLARE_SCHEDULED_EVENT, type CloudflareScheduledEvent } from '../../scheduled-event';

// 2024-01-08 is a Monday.
const mondayNine = Date.UTC(2024, 0, 8, 9);

describe('native scheduled controller contract', () => {
  it('passes one ScheduleInvocation per job with bindings, noRetry and fresh scopes under workerd', async () => {
    const seen: Array<{ name: string; scope: object; tick: ScheduleInvocation; args: number }> = [];
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      constructor(
        @InjectEnv() readonly bindings: VelaEnv,
        @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
        @Inject(CLOUDFLARE_SCHEDULED_EVENT) readonly trigger: CloudflareScheduledEvent,
      ) {}
      @Cron('0 9 * * MON-FRI', { dialect: 'cloudflare' })
      run(...args: ScheduleInvocation[]) {
        const [tick] = args;
        if (!tick) throw new Error('missing invocation');
        // Destructured on purpose: an unbound native noRetry throws Illegal invocation.
        const { noRetry } = this.trigger;
        noRetry();
        this.lifetime.waitUntil(
          Promise.resolve().then(() => {
            const name: unknown = Reflect.get(this.bindings, 'name');
            seen.push({ name: String(name), scope: this, tick, args: args.length });
            return undefined;
          }),
        );
      }
    }
    @Module({ providers: [Job] })
    class Root {}
    const worker = createCloudflareWorker(Root);
    const event = createScheduledController({
      cron: '0 9 * * MON-FRI',
      scheduledTime: 1_704_703_200_000,
    });
    const context = createExecutionContext();
    // Two environment identities; each carries a synthetic marker over the real bindings.
    const a = { ...env, name: 'a' };
    await Promise.all([
      worker.scheduled(event, a, context),
      worker.scheduled(event, { ...env, name: 'b' }, context),
    ]);
    await waitOnExecutionContext(context);
    expect(seen.map((entry) => entry.name).toSorted()).toEqual(['a', 'b']);
    expect(new Set(seen.map((entry) => entry.scope)).size).toBe(2);
    expect(seen.every((entry) => entry.args === 1)).toBe(true);
    for (const { tick } of seen) {
      expect(tick).toMatchObject({
        kind: 'cron',
        expression: event.cron,
        scheduledTime: event.scheduledTime,
      });
      expect(tick.signal.aborted).toBe(false);
    }
  });

  it('numbers weekdays from 1 = Sunday for cloudflare-dialect jobs', async () => {
    const fired: Array<{ job: string; day: number; cloudflare: boolean; unix: boolean }> = [];
    const record = (job: string, tick: ScheduleInvocation) => {
      if (tick.kind !== 'cron') throw new Error('expected a cron invocation');
      const at = new Date(tick.scheduledTime);
      fired.push({
        job,
        day: at.getUTCDay(),
        cloudflare: parseCron(tick.expression, { dialect: 'cloudflare' })?.(at) ?? false,
        unix: parseCron(tick.expression, { dialect: 'unix', timeZone: 'UTC' })?.(at) ?? false,
      });
    };
    @Injectable()
    class Weekly {
      @Cron('0 9 * * 2', { dialect: 'cloudflare' })
      monday(tick: ScheduleInvocation) {
        record('monday', tick);
      }
      @Cron('0 9 * * 1', { dialect: 'cloudflare' })
      sunday(tick: ScheduleInvocation) {
        record('sunday', tick);
      }
      @Cron('0 9 * * MON', { dialect: 'cloudflare' })
      named(tick: ScheduleInvocation) {
        record('named', tick);
      }
    }
    @Module({ providers: [Weekly] })
    class Root {}
    const worker = createCloudflareWorker(Root);

    const monday = (cron: string) =>
      worker.scheduled(
        createScheduledController({ cron, scheduledTime: mondayNine }),
        env,
        createExecutionContext(),
      );
    await monday('0 9 * * 2');
    await monday('0 9 * * MON');
    const sundayNine = Date.UTC(2024, 0, 7, 9);
    await worker.scheduled(
      createScheduledController({ cron: '0 9 * * 1', scheduledTime: sundayNine }),
      env,
      createExecutionContext(),
    );

    expect(fired).toEqual([
      { job: 'monday', day: 1, cloudflare: true, unix: false },
      { job: 'named', day: 1, cloudflare: true, unix: true },
      { job: 'sunday', day: 0, cloudflare: true, unix: false },
    ]);
  });

  it('runs global guards through signed schedule dispatch', async () => {
    const seen: string[] = [];
    const jobs: ScheduleJobRef[] = [];
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
    // The signing secret is the URL_SIGNING_SECRET variable wrangler.test.toml seeds into ENV.
    @Module({
      imports: [
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
    const worker = createCloudflareWorker(Root);
    const context = createExecutionContext();

    await worker.scheduled(
      createScheduledController({ cron: '0 3 * * *', scheduledTime: Date.UTC(2024, 0, 8, 3) }),
      env,
      context,
    );
    await waitOnExecutionContext(context);

    expect(seen).toEqual(['guard:http', 'route']);
    expect(jobs).toEqual([{ kind: 'cron', expression: '0 3 * * *', methodName: 'nightly' }]);
  });

  it('refuses a direct job that declares guards and reports why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ran: string[] = [];
    const report = vi.fn();
    try {
      class Allow implements CanActivate {
        canActivate(): boolean {
          return true;
        }
      }
      @Injectable()
      class Jobs {
        @Cron('0 4 * * *', { dialect: 'cloudflare' })
        @UseGuards(Allow)
        nightly() {
          ran.push('nightly');
        }
      }
      @Module({
        providers: [Jobs, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
      })
      class Root {}
      const worker = createCloudflareWorker(Root);

      await expect(
        worker.scheduled(
          createScheduledController({ cron: '0 4 * * *', scheduledTime: mondayNine }),
          env,
          createExecutionContext(),
        ),
      ).rejects.toThrow(
        /Jobs\.nightly declares @UseGuards, but guards do not run for directly dispatched scheduled jobs/,
      );
      expect(ran).toEqual([]);
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/kind: 'signed'/) }),
        expect.objectContaining({ edge: 'schedule', source: 'Jobs.nightly' }),
      );
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
        expect.arrayContaining([expect.stringMatching(/one that declares guards refuses to run/)]),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('only warns about declarations Workers cannot honor when the first event bootstraps', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ran: string[] = [];
    try {
      @Injectable()
      class Mixed {
        @Cron('30 6 * * 1')
        ambiguous() {
          ran.push('ambiguous');
        }
        @Interval(45_000)
        poll() {
          ran.push('interval');
        }
      }
      @Module({ providers: [Mixed] })
      class Root {}
      const worker = createCloudflareWorker(Root);

      await worker.scheduled(
        createScheduledController({
          cron: '30 6 * * 1',
          scheduledTime: Date.UTC(2024, 0, 7, 6, 30),
        }),
        env,
        createExecutionContext(),
      );

      expect(ran).toEqual(['ambiguous']);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => /Mixed\.ambiguous declares no dialect/.test(message))).toBe(
        true,
      );
      expect(messages.some((message) => /@Interval\(45000\) on Mixed\.poll/.test(message))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scheduled jobs fired outside a trigger', () => {
  it('seeds a synthetic trigger event under workerd', async () => {
    const seen: Array<{ cron: string; scheduledTime: number; expression: string }> = [];
    @Injectable({ scope: Scope.REQUEST })
    class Exports {
      constructor(
        @Inject(CLOUDFLARE_SCHEDULED_EVENT) private readonly trigger: CloudflareScheduledEvent,
        @Inject(EXECUTION_LIFETIME) private readonly lifetime: ExecutionLifetime,
      ) {}
      @Cron('30 2 * * *', { dialect: 'cloudflare' })
      nightly(tick: CronInvocation) {
        this.trigger.noRetry();
        this.lifetime.waitUntil(
          Promise.resolve().then(() => {
            seen.push({
              cron: this.trigger.cron,
              scheduledTime: this.trigger.scheduledTime,
              expression: tick.expression,
            });
          }),
        );
      }
    }
    @Module({ providers: [Exports] })
    class App {}
    const app = await VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })] });
    try {
      const container = app.getContainer();
      const seed = container.resolve(SCHEDULE_INVOCATION_SEED);
      const [entry] = app.entrypoints.ofKind('schedule:cron', parseCronMetadata);
      const invocation: CronInvocation = {
        kind: 'cron',
        expression: '30 2 * * *',
        scheduledTime: mondayNine,
        signal: new AbortController().signal,
      };
      await invokeScheduledJob(container, entry!, invocation, {
        seed: (scope) => seed(scope, invocation),
      });
      expect(seen).toEqual([
        { cron: '30 2 * * *', scheduledTime: mondayNine, expression: '30 2 * * *' },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('Durable Objects built from a graph with cron jobs', () => {
  it('boots when a @Cron job injects CLOUDFLARE_SCHEDULED_EVENT', async () => {
    const namespace = env.CRON_ROOM;
    const room = namespace.get(namespace.idFromName('nightly'));
    await expect(room.inspectLive()).resolves.toEqual({ subscriptions: [], rooms: [] });
  });
});
