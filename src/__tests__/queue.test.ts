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
    @Injectable()
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
      imports: [QueueModule.forRoot({ queues: ['email'], driver })],
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
    @Injectable()
    class A {
      @Process()
      run() {
        seen.push('A');
      }
    }

    @Processor('audit')
    @Injectable()
    class B {
      @Process()
      run() {
        seen.push('B');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ queues: ['audit'], driver })],
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

    @Module({ imports: [QueueModule.forRoot({ queues: ['ghost'], driver })] })
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
    @Injectable()
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
      imports: [QueueModule.forRoot({ queues: ['work'], driver })],
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
    @Injectable()
    class KnownFilter implements ExceptionFilter {
      catch(error: unknown) {
        claimed.push((error as Error).message);
      }
    }

    @Processor('jobs')
    @Injectable()
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
      imports: [QueueModule.forRoot({ queues: ['jobs'], driver })],
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
    @Injectable()
    class ScopedProcessor {
      constructor(@Inject(PerJobDep) readonly dep: PerJobDep) {}

      @Process()
      run() {}
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ queues: ['scoped'], driver })],
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
    @Injectable()
    class NowProcessor {
      @Process()
      run(job: QueueJob) {
        seen.push(job.name);
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ queues: ['now'] })], // default inline() immediate
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

    @Module({ imports: [QueueModule.forRoot({ queues: ['later'], driver })] })
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
    @Module({ imports: [QueueModule.forRoot({ queues: ['late'] })] })
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
    @Module({ imports: [QueueModule.forRoot({ queues: ['real'] })] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(() => app.get(queueToken('typo-queue'))).toThrow(/vela:queue:client:typo-queue/);
    await app.dispose();
  });

  it('identical forRoot options dedup into one module instance', async () => {
    const first = QueueModule.forRoot({ queues: ['dedup'] });
    const second = QueueModule.forRoot({ queues: ['dedup'] });

    @Module({ imports: [first, second] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.getContainer().getOwnerModuleIds(queueToken('dedup'))).toHaveLength(1);
    await app.dispose();
  });

  it('rejects the same queue name provided by two module instances', async () => {
    const other: QueueDriver = { kind: 'other', enqueue: async () => {} };

    @Module({
      imports: [
        QueueModule.forRoot({ queues: ['clash'] }),
        QueueModule.forRoot({ queues: ['clash'], driver: other }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    expect(() => app.get(queueToken('clash'))).toThrow(
      /Multiple providers|provided by multiple QueueModule instances/,
    );
    await app.dispose();
  });

  it('forRootAsync takes queues structurally alongside the factory', async () => {
    const { driver } = manualApp();
    const seen: string[] = [];

    @Processor('async-q')
    @Injectable()
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
          queues: ['async-q'],
          useFactory: async () => ({ driver }),
        }),
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

  it('forRootAsync without structural queues fails fast at call time', () => {
    expect(() => QueueModule.forRootAsync({ useFactory: async () => ({}) })).toThrow(
      /queues.*structural/,
    );
  });
});

describe('laziness (dogfoods 1.13 lazy modules)', () => {
  it('stays unmaterialized in consumer-only apps; platform dispatch needs no module', async () => {
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
    @Injectable()
    class RemoteProcessor {
      @Process()
      run(job: QueueJob) {
        handledJobs.push(job.name);
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ queues: ['remote'], driver })],
      providers: [RemoteProcessor],
    })
    class App {}

    const app = await VelaFactory.create(App);
    // No producer injected a client → the module is still pending.
    expect(bound).toBe(false);

    // Platform-style dispatch works without materializing QueueModule.
    const result = await dispatchQueueJob(app.getContainer(), app.entrypoints, {
      id: '1',
      queue: 'remote',
      name: 'platform-job',
      data: {},
      attempt: 1,
    });
    expect(result.handled).toBe(1);
    expect(handledJobs).toEqual(['platform-job']);
    expect(bound).toBe(false);

    // First client resolution materializes the module (binds the driver).
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
      imports: [QueueModule.forRoot({ queues: ['orders'], driver })],
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
    @Injectable()
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
      imports: [QueueModule.forRoot({ queues: ['boot'] })],
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
    @Injectable()
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
      imports: [QueueModule.forRoot({ queues: ['lazy-q'], driver }), LazyConsumers],
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
    @Injectable()
    class ThrowingProcessor {
      @Process()
      run() {
        throw new Error('kaboom');
      }
    }

    const { driver } = manualApp();

    @Module({
      imports: [QueueModule.forRoot({ queues: ['reportq'], driver })],
      providers: [ThrowingProcessor, { provide: APP_EXCEPTION_HANDLER, useValue: { report } }],
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

  it('routes the inline driver fire-and-forget error through APP_EXCEPTION_HANDLER, not console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = vi.fn();

    @Processor('inlinereport')
    @Injectable()
    class BoomProcessor {
      @Process()
      run() {
        throw new Error('detached-boom');
      }
    }

    @Module({
      imports: [QueueModule.forRoot({ queues: ['inlinereport'] })], // default inline() immediate
      providers: [BoomProcessor, { provide: APP_EXCEPTION_HANDLER, useValue: { report } }],
    })
    class App {}

    const app = await VelaFactory.create(App);
    await app.get<QueueClient>(queueToken('inlinereport')).add('ping', {});
    await settle();

    // The binding's fire-and-forget default arm reports instead of bare console.error.
    expect(report).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ edge: 'queue', note: 'inline driver' }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    await app.dispose();
  });
});
