import { defineProvider } from '../container/types';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  CanActivate,
  Inject,
  Injectable,
  MetadataRegistry,
  Module,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  VelaFactory,
  Catch,
} from '../index.js';
import type {
  CallHandler,
  ErrorReportContext,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from '../index.js';
import {
  dispatchQueueJob,
  inline,
  Process,
  Processor,
  QueueClient,
  QueueModule,
  QUEUE_DRIVER,
  queueToken,
} from '../queue/index.js';
import type { InlineQueueDriver, QueueDriver, QueueJob } from '../queue/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function manualApp() {
  const driver = inline({ mode: 'manual' });
  return { driver };
}

describe('QueueModule routing', () => {
  it('routes named jobs to @Process(name) and the rest to the wildcard', async () => {
    const seen: string[] = [];

    @Processor('email')
    class EmailProcessor {
      @Process('welcome')
      welcome(job: QueueJob) {
        seen.push(`welcome:${job.id}`);
      }

      @Process()
      fallback(job: QueueJob) {
        seen.push(`fallback:${job.name}`);
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'email' })],
      providers: [EmailProcessor],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const email = app.get<QueueClient>(queueToken('email'));

    const welcome = await email.add('welcome', {});
    await email.add('digest', {});
    expect(await driver.flush()).toBe(2);

    expect(seen).toEqual([`welcome:${welcome.id}`, 'fallback:digest']);
    await app.dispose();
  });

  it('fans one job out to every processor of the queue', async () => {
    const seen: string[] = [];

    @Processor('audit')
    class A {
      @Process()
      run() {
        seen.push('A');
      }
    }

    @Processor('audit')
    class B {
      @Process()
      run() {
        seen.push('B');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'audit' })],
      providers: [A, B],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('audit')).add('event', {});
    await driver.flush();

    expect(seen.sort()).toEqual(['A', 'B']);
    await app.dispose();
  });

  it('drops jobs for queues without processors with a log-mode warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'ghost' })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('ghost')).add('job', {});
    expect(await driver.flush()).toBe(1);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no @Processor('ghost')"));
    warn.mockRestore();
    await app.dispose();
  });
});

describe('QueueModule pipeline', () => {
  it('runs scoped guards, interceptors, and filters around handlers', async () => {
    const order: string[] = [];

    @Injectable()
    class JobGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        order.push(`guard:${ctx.getType()}`);
        return true;
      }
    }

    @Injectable()
    class JobInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push('intercept:before');
        const out = await next.handle();
        order.push('intercept:after');
        return out;
      }
    }

    @Processor('work')
    @UseGuards(JobGuard)
    @UseInterceptors(JobInterceptor)
    class WorkProcessor {
      @Process()
      run() {
        order.push('handler');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'work' })],
      providers: [WorkProcessor, JobGuard, JobInterceptor],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('work')).add('job', {});
    await driver.flush();

    expect(order).toEqual(['guard:queue', 'intercept:before', 'handler', 'intercept:after']);
    await app.dispose();
  });

  it('lets scoped filters claim errors; unclaimed errors reject flush()', async () => {
    class KnownError extends Error {}
    const claimed: string[] = [];

    @Catch(KnownError)
    class KnownFilter implements ExceptionFilter {
      catch(error: unknown) {
        claimed.push((error as Error).message);
      }
    }

    @Processor('jobs')
    @UseFilters(KnownFilter)
    class JobsProcessor {
      @Process('known')
      known() {
        throw new KnownError('claimed');
      }

      @Process('unknown')
      unknown() {
        throw new Error('unclaimed');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'jobs' })],
      providers: [JobsProcessor, KnownFilter],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const jobs = app.get<QueueClient>(queueToken('jobs'));

    await jobs.add('known', {});
    expect(await driver.flush()).toBe(1);
    expect(claimed).toEqual(['claimed']);

    await jobs.add('unknown', {});
    await expect(driver.flush()).rejects.toThrow(AggregateError);
    await app.dispose();
  });

  it('rebuilds request-scoped dependencies per job', async () => {
    let constructions = 0;

    @Injectable({ scope: Scope.REQUEST })
    class PerJobDep {
      constructor() {
        constructions++;
      }
    }

    @Processor('scoped')
    class ScopedProcessor {
      constructor(@Inject(PerJobDep) readonly dep: PerJobDep) {}

      @Process()
      run() {}
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'scoped' })],
      providers: [ScopedProcessor, PerJobDep],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const scoped = app.get<QueueClient>(queueToken('scoped'));
    await scoped.add('one', {});
    await scoped.add('two', {});
    await driver.flush();

    expect(constructions).toBe(2);
    await app.dispose();
  });
});

describe('inline driver', () => {
  it('immediate mode delivers on a following microtask', async () => {
    const seen: string[] = [];

    @Processor('now')
    class NowProcessor {
      @Process()
      run(job: QueueJob) {
        seen.push(job.name);
      }
    }

    @Module({
      imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'now' })], // default inline() immediate
      providers: [NowProcessor],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('now')).add('ping', {});
    expect(seen).toEqual([]); // add() resolving ≠ handled
    await settle();
    expect(seen).toEqual(['ping']);
    await app.dispose();
  });

  it('warns once when delayMs is requested', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'later' })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const later = app.get<QueueClient>(queueToken('later'));
    await later.add('a', {}, { delayMs: 50 });
    await later.add('b', {}, { delayMs: 50 });

    const delayWarnings = warn.mock.calls.filter(([msg]) =>
      String(msg).includes('does not support delayMs'),
    );
    expect(delayWarnings).toHaveLength(1);
    warn.mockRestore();
    await app.dispose();
  });

  it('does not crash on add() after dispose', async () => {
    @Module({ imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'late' })] })
    class App {}

    const app = await VelaFactory.create(App);
    const late = app.get<QueueClient>(queueToken('late'));
    await app.dispose();

    await expect(late.add('after-dispose', {})).resolves.toMatchObject({ name: 'after-dispose' });
    await settle();
  });
});

describe('queue tokens and module identity', () => {
  it('queueToken is memoized per name', () => {
    expect(queueToken('same')).toBe(queueToken('same'));
    expect(queueToken('same')).not.toBe(queueToken('other'));
  });

  it('fails with the queue name in the error for unregistered queues', async () => {
    @Module({ imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'real' })] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(() => app.get(queueToken('typo-queue'))).toThrow(/vela:queue:client:typo-queue/);
    await app.dispose();
  });

  it('identical forRoot options and registrations dedup into one module instance', async () => {
    const first = [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'dedup' })];
    const second = [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'dedup' })];

    @Module({ imports: [...first, ...second] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.getContainer().getOwnerModuleIds(queueToken('dedup'))).toHaveLength(1);
    expect(app.getContainer().getOwnerModuleIds(QUEUE_DRIVER)).toHaveLength(1);
    await app.dispose();
  });

  it('rejects two driver configurations in one application', async () => {
    const other: QueueDriver = { kind: 'other', enqueue: async () => {} };

    @Module({
      imports: [
        QueueModule.forRoot(),
        QueueModule.forRoot({ driver: other }),
        QueueModule.registerQueue({ name: 'clash' }),
      ],
    })
    class App {}

    await expect(VelaFactory.create(App)).rejects.toThrow(
      /QueueModule\.forRoot\(\) is imported with different options/,
    );
  });

  it('forRootAsync resolves the driver and dispatch policy from its factory', async () => {
    const { driver } = manualApp();
    const seen: string[] = [];

    @Processor('async-q')
    class AsyncProcessor {
      @Process()
      run(job: QueueJob) {
        seen.push(job.name);
      }
    }

    // Async options make the module's OPTIONS factory async, so (per the 1.13
    // lazy contract) it must first materialize through an async seam — here
    // the bootstrap sweep, via an eager producer injecting the client. A
    // consumer-only app would call app.materializeLazyModules() instead.
    @Injectable()
    class AsyncProducer {
      constructor(@Inject(queueToken('async-q')) readonly q: QueueClient) {}
    }

    @Module({
      imports: [
        QueueModule.forRootAsync({
          inject: [],
          useFactory: async () => ({ driver, dispatch: { kind: 'direct' } }),
        }),
        QueueModule.registerQueue({ name: 'async-q' }),
      ],
      providers: [AsyncProcessor, AsyncProducer],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get(AsyncProducer).q.add('hello', {});
    await driver.flush();
    expect(seen).toEqual(['hello']);
    await app.dispose();
  });
});

describe('transport initialization', () => {
  it('initializes consumer-only transports at bootstrap so native routes are discoverable', async () => {
    let bound = false;
    const driver: QueueDriver = {
      kind: 'probe',
      enqueue: async () => {},
      bind: () => {
        bound = true;
      },
    };

    const handledJobs: string[] = [];

    @Processor('remote')
    class RemoteProcessor {
      @Process()
      run(job: QueueJob) {
        handledJobs.push(job.name);
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'remote' })],
      providers: [RemoteProcessor],
    })
    class App {}

    const app = await VelaFactory.create(App);
    expect(bound).toBe(true);

    // Each delivery still resolves processors in a fresh invocation scope.
    const result = await dispatchQueueJob(app.getContainer(), app.entrypoints, {
      id: '1',
      queue: 'remote',
      name: 'platform-job',
      data: {},
      attempt: 1,
    });
    expect(result.handled).toBe(1);
    expect(handledJobs).toEqual(['platform-job']);
    expect(bound).toBe(true);

    // Client resolution reuses the configured transport.
    app.get(queueToken('remote'));
    expect(bound).toBe(true);
    await app.dispose();
  });

  it('materializes at bootstrap when an eager producer injects a client', async () => {
    let bound = false;
    const driver: QueueDriver = {
      kind: 'probe',
      enqueue: async () => {},
      bind: () => {
        bound = true;
      },
    };

    @Injectable()
    class ProducerService {
      constructor(@Inject(queueToken('orders')) readonly orders: QueueClient) {}
    }

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'orders' })],
      providers: [ProducerService],
    })
    class App {}

    const app = await VelaFactory.create(App);
    expect(bound).toBe(true); // documented reality — same reason WebSocketModule stays eager
    await app.dispose();
  });

  it('delivers jobs added during onModuleInit (pre-registry discovery fallback)', async () => {
    const seen: string[] = [];

    @Processor('boot')
    class BootProcessor {
      @Process()
      run(job: QueueJob) {
        seen.push(job.name);
      }
    }

    @Injectable()
    class EagerProducer {
      constructor(@Inject(queueToken('boot')) private readonly boot: QueueClient) {}
      async onModuleInit() {
        await this.boot.add('from-init', {});
      }
    }

    @Module({
      imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'boot' })],
      providers: [BootProcessor, EagerProducer],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await settle();
    expect(seen).toEqual(['from-init']);
    await app.dispose();
  });

  it('materializes lazy processor modules (async init hooks included) on first dispatch', async () => {
    const events: string[] = [];

    @Processor('lazy-q')
    class LazyProcessor {
      private ready = false;

      async onModuleInit() {
        await Promise.resolve();
        this.ready = true;
        events.push('init');
      }

      @Process()
      run(job: QueueJob) {
        events.push(`handled:${job.name}:ready=${this.ready}`);
      }
    }

    @Module({ lazy: true, providers: [LazyProcessor] })
    class LazyConsumers {}

    const { driver } = manualApp();

    @Module({
      imports: [
        QueueModule.forRoot({ driver }),
        QueueModule.registerQueue({ name: 'lazy-q' }),
        LazyConsumers,
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);

    // Declared kind with a lazy provider → metadata-only entry pre-dispatch.
    const entries = app.entrypoints.ofKind('queue');
    expect(entries).toHaveLength(1);
    expect(entries[0].instance).toBeUndefined();

    await app.get<QueueClient>(queueToken('lazy-q')).add('first', {});
    await driver.flush();

    expect(events).toEqual(['init', 'handled:first:ready=true']);
    await app.dispose();
  });
});

describe('error reporter edge (report-then-rethrow)', () => {
  it('reports an unclaimed processor error before rethrowing (platform retry preserved)', async () => {
    const reports: Array<{ error: unknown; ctx: ErrorReportContext }> = [];
    const report = vi.fn((error: unknown, ctx: ErrorReportContext) => {
      reports.push({ error, ctx });
    });

    @Processor('reportq')
    class ThrowingProcessor {
      @Process()
      run() {
        throw new Error('kaboom');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'reportq' })],
      providers: [
        ThrowingProcessor,
        defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('reportq')).add('go', {});

    // The unclaimed error still rejects the dispatch → the platform retries.
    await expect(driver.flush()).rejects.toThrow(AggregateError);
    // …and report ran before that rethrow, carrying edge + source.
    expect(report).toHaveBeenCalledTimes(1);
    expect(reports[0].ctx).toMatchObject({ edge: 'queue', source: 'ThrowingProcessor.run' });
    expect((reports[0].error as Error).message).toBe('kaboom');
    await app.dispose();
  });

  it('reports a detached inline delivery failure once through APP_EXCEPTION_HANDLER, not console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = vi.fn();

    @Processor('inlinereport')
    class BoomProcessor {
      @Process()
      run() {
        throw new Error('detached-boom');
      }
    }

    @Module({
      imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'inlinereport' })], // default inline() immediate
      providers: [BoomProcessor, defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('inlinereport')).add('ping', {});
    await settle();

    // The processor reported its failure; the binding's fire-and-forget arm
    // does not report it again, and nothing reaches a bare console.error.
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'detached-boom' }),
      expect.objectContaining({ edge: 'queue', source: 'BoomProcessor.run' }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    await app.dispose();
  });

  it('reports each failed processor of a detached inline delivery once, thrown values included', async () => {
    const reports: unknown[] = [];

    @Processor('inlinemany')
    class First {
      @Process()
      run() {
        throw new Error('first failed');
      }
    }
    @Processor('inlinemany')
    class Second {
      @Process()
      run() {
        // A careless processor may throw a value that is not an Error.
        throw 'second failed';
      }
    }

    @Module({
      imports: [QueueModule.forRoot(), QueueModule.registerQueue({ name: 'inlinemany' })],
      providers: [
        First,
        Second,
        defineProvider(APP_EXCEPTION_HANDLER, {
          useValue: { report: (error: unknown) => reports.push(error) },
        }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('inlinemany')).add('ping', {});
    await settle();

    expect(reports).toHaveLength(2);
    expect(reports).toContainEqual(expect.objectContaining({ message: 'first failed' }));
    expect(reports).toContain('second failed');
    await app.dispose();
  });

  it('reports a detached delivery failure no processor reported, noting the inline driver', async () => {
    const report = vi.fn();
    let onError: ((error: unknown, job: QueueJob) => void) | undefined;
    const driver: QueueDriver = {
      kind: 'detached',
      async enqueue() {},
      bind(_dispatch, hooks) {
        onError = hooks?.onError;
      },
    };

    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'detached' })],
      providers: [defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    })
    class App {}

    const app = await VelaFactory.create(App);
    const job = { id: 'j', queue: 'detached', name: 'ping', data: {}, attempt: 1 };
    onError?.(new Error('transport failed'), job);

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transport failed' }),
      expect.objectContaining({ edge: 'queue', source: 'detached/ping', note: 'inline driver' }),
    );
    await app.dispose();
  });
});
