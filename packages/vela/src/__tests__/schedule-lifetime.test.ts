import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_LIFETIME,
  defineProvider,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
  type VelaApplication,
  type ExecutionLifetime,
} from '../index';
import { APP_EXCEPTION_HANDLER } from '../pipeline/tokens';
import { Cron, Interval, ScheduleRegistry, type ScheduleInvocation } from '../schedule';
import { ScheduleNodeModule, ScheduleExecutor } from '../schedule-node';

const applications: VelaApplication[] = [];
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});
const create = async (root: Parameters<typeof VelaFactory.create>[0]) => {
  const app = await VelaFactory.create(root, { diagnostics: 'silent' });
  applications.push(app);
  return app;
};

describe('Node scheduled invocation ownership', () => {
  it('does not invoke a handler whose async construction finishes after shutdown begins', async () => {
    const hold = gate();
    const resource = new InjectionToken<{ dispose(): void }>('pending schedule resource');
    let invoked = 0;
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      constructor(@Inject(resource) readonly owned: { dispose(): void }) {}
      @Interval(100) run() {
        invoked++;
      }
    }
    @Module({
      imports: [ScheduleNodeModule],
      providers: [
        Job,
        defineProvider(resource, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: async () => {
            await hold.promise;
            return {
              dispose() {
                disposed++;
              },
            };
          },
        }),
      ],
    })
    class Root {}
    const app = await create(Root);
    await vi.advanceTimersByTimeAsync(100);
    const closed = app.close();
    hold.release();
    await closed;
    expect(invoked).toBe(0);
    expect(disposed).toBe(1);
  });

  it('constructs and disposes request-scoped jobs for every overlapping tick', async () => {
    const hold = gate();
    const seen: number[] = [];
    const disposed: number[] = [];
    let next = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      readonly id = ++next;
      @Interval(100)
      async run(tick: ScheduleInvocation) {
        expect(tick.kind).toBe('interval');
        expect(tick.signal.aborted).toBe(false);
        seen.push(this.id);
        await hold.promise;
      }
      dispose() {
        disposed.push(this.id);
      }
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job] })
    class Root {}
    const app = await create(Root);
    expect(next).toBe(0);
    expect(app.get(ScheduleRegistry).getIntervalEntrypoints()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([1, 2]);
    expect(disposed).toEqual([]);
    hold.release();
    await app.close();
    expect(disposed.toSorted()).toEqual([1, 2]);
  });

  it('resolves async scoped dependencies and transient handlers at each fire', async () => {
    const value = new InjectionToken<number>('per-tick async result');
    let serial = 0;
    const seen: number[] = [];
    @Injectable({ scope: Scope.TRANSIENT })
    class Job {
      constructor(@Inject(value) readonly number: number) {}
      @Interval(100) run() {
        seen.push(this.number);
      }
    }
    @Module({
      imports: [ScheduleNodeModule],
      providers: [
        defineProvider(value, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: async () => ++serial,
        }),
        Job,
      ],
    })
    class Root {}
    await create(Root);
    expect(serial).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([1, 2]);
  });

  it('retains singleton identity while exposing metadata-only entrypoints', async () => {
    const instances: object[] = [];
    @Injectable()
    class Job {
      @Interval(100) run() {
        instances.push(this);
      }
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job] })
    class Root {}
    const app = await create(Root);
    await vi.advanceTimersByTimeAsync(250);
    expect(instances).toEqual([app.get(Job), app.get(Job)]);
    expect(app.get(ScheduleRegistry).getIntervalEntrypoints()[0]?.instance).toBeUndefined();
  });

  it('keeps the same job class independent in two keyed module registrations', async () => {
    const database = new InjectionToken<{ name: string }>('module database');
    const seen: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      constructor(@Inject(database) readonly db: { name: string }) {}
      @Interval(100) run() {
        seen.push(this.db.name);
      }
    }
    class DatabaseJobs {}
    @Module({
      imports: [
        ScheduleNodeModule,
        ...['primary', 'archive'].map((key) => ({
          module: DatabaseJobs,
          key,
          providers: [Job, defineProvider(database, { useValue: { name: key } })],
        })),
      ],
    })
    class Root {}
    const app = await create(Root);
    const entries = app.get(ScheduleRegistry).getIntervalEntrypoints();
    expect(new Set(entries.map((entry) => entry.moduleId)).size).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.toSorted()).toEqual(['archive', 'primary']);
  });

  it('keeps separate applications independent when one stops', async () => {
    let total = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      @Interval(100) run() {
        total++;
      }
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job] })
    class Root {}
    const a = await create(Root);
    await create(Root);
    await vi.advanceTimersByTimeAsync(100);
    expect(total).toBe(2);
    await a.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(total).toBe(3);
  });

  it('aborts active jobs and drains their managed work before disposal or provider destruction', async () => {
    const hold = gate();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    @Injectable()
    class Database {
      onModuleDestroy() {
        events.push('database destroyed');
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      constructor(
        @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
        readonly database: Database,
      ) {}
      @Interval(100)
      async run(tick: ScheduleInvocation) {
        signal = tick.signal;
        const lifetime = this.lifetime;
        expect(lifetime?.signal).toBe(signal);
        lifetime?.defer(async () => {
          await hold.promise;
          events.push('deferred');
        });
        await new Promise<void>((resolve) =>
          tick.signal.addEventListener(
            'abort',
            () => {
              events.push('abort');
              resolve();
            },
            { once: true },
          ),
        );
      }
      dispose() {
        events.push('job disposed');
      }
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job, Database] })
    class Root {}
    const app = await create(Root);
    await vi.advanceTimersByTimeAsync(100);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual(['abort']);
    expect(closed).toBe(false);
    hold.release();
    await closing;
    expect(events).toEqual(['abort', 'deferred', 'job disposed', 'database destroyed']);
    expect(app.get(ScheduleExecutor).onModuleDestroy()).toBe(
      app.get(ScheduleExecutor).onModuleDestroy(),
    );
  });

  it('reports a failed invocation, disposes it and continues without hidden retries', async () => {
    const report = vi.fn();
    let calls = 0;
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      @Interval(100) run() {
        calls++;
        throw new Error('scheduled failure');
      }
      dispose() {
        disposed++;
      }
    }
    @Module({
      imports: [ScheduleNodeModule],
      providers: [Job, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class Root {}
    await create(Root);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);
    expect(disposed).toBe(2);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({ edge: 'schedule', source: 'Job.run' }),
    );
  });

  it('observes diagnostics:throw failures and exposes the first error through shutdown', async () => {
    const failure = new Error('strict failure');
    const report = vi.fn();
    let calls = 0;
    @Injectable()
    class Job {
      @Interval(100) run() {
        calls++;
        throw failure;
      }
    }
    @Module({
      imports: [ScheduleNodeModule],
      providers: [Job, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class Root {}
    const app = await VelaFactory.create(Root, { diagnostics: 'throw' });
    applications.push(app);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    await expect(app.close()).rejects.toBe(failure);
  });

  it('validates the complete schedule before starting any timers', async () => {
    @Injectable()
    class Job {
      @Interval(100) tick() {}
      @Cron('bad cron') invalid() {}
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job] })
    class Root {}
    await expect(create(Root)).rejects.toThrow('Invalid cron expression for invalid');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides a scheduled minute boundary and obeys the explicit native dialect', async () => {
    vi.setSystemTime(new Date('2024-01-07T09:00:00Z'));
    const times: number[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Job {
      @Cron('0 9 * * 1', { dialect: 'cloudflare' })
      sunday(tick: ScheduleInvocation) {
        times.push(tick.scheduledTime);
      }
    }
    @Module({ imports: [ScheduleNodeModule], providers: [Job] })
    class Root {}
    await create(Root);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(times).toEqual([Date.UTC(2024, 0, 7, 9)]);
  });
});
