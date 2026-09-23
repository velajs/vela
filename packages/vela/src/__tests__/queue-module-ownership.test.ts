import { describe, expect, it } from 'vitest';
import {
  Catch,
  UseFilters,
  defineProvider,
  getExecutionLifetime,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  UseGuards,
  VelaFactory,
} from '../index';
import type { CanActivate, ExecutionContext } from '../index';
import { dispatchQueueJob, inline, Process, Processor, QueueModule, queueToken } from '../queue';

const job = { id: 'job', queue: 'owners', name: 'work', data: {}, attempt: 1 };

describe('queue entrypoint module ownership and lifetime', () => {
  it('resolves the same processor token in each keyed module, including lazy async options', async () => {
    const NAME = new InjectionToken<string>('queue owner name');
    const seen: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    @Processor('owners')
    class Consumer {
      constructor(@Inject(NAME) readonly name: string) {}
      @Process() handle() {
        seen.push(this.name);
      }
    }
    class Feature {}
    @Module({
      imports: ['first', 'second'].map((key) => ({
        module: Feature,
        key,
        lazy: true,
        providers: [Consumer, defineProvider(NAME, { inject: [], useFactory: async () => key })],
      })),
    })
    class App {}
    const app = await VelaFactory.create(App);
    await dispatchQueueJob(app.getContainer(), app.entrypoints, job);
    expect(seen.toSorted()).toEqual(['first', 'second']);
    await app.close();
  });

  it('uses owned metadata discovery for jobs emitted before the registry is installed', async () => {
    const NAME = new InjectionToken<string>('early queue owner');
    const seen: string[] = [];
    @Injectable()
    @Processor('owners')
    class Consumer {
      constructor(@Inject(NAME) readonly name: string) {}
      @Process() handle() {
        seen.push(this.name);
      }
    }
    @Injectable()
    class Producer {
      constructor(
        @Inject(queueToken('owners')) readonly client: {
          add(name: string, data: unknown): Promise<unknown>;
        },
      ) {}
      async onModuleInit() {
        await this.client.add('work', {});
        await driver.flush();
      }
    }
    const driver = inline({ mode: 'manual' });
    class Feature {}
    @Module({
      imports: [
        QueueModule.forRoot({ driver }),
        QueueModule.registerQueue({ name: 'owners' }),
        ...['a', 'b'].map((key) => ({
          module: Feature,
          key,
          providers: [Consumer, defineProvider(NAME, { useValue: key })],
        })),
      ],
      providers: [Producer],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect(seen.toSorted()).toEqual(['a', 'b']);
    await app.close();
  });

  it('waits for managed deferred work and avoids constructing a guarded request processor', async () => {
    let constructed = 0;
    const seen: string[] = [];
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        const container = context.getContainer?.();
        expect(context.getModuleId?.()).toBeDefined();
        if (!container) throw new Error('missing invocation container');
        getExecutionLifetime(container)!.defer(async () => {
          await Promise.resolve();
          seen.push('deferred');
        });
        return false;
      },
    };
    @Injectable({ scope: Scope.REQUEST })
    @Processor('owners')
    class Consumer {
      constructor() {
        constructed++;
      }
      @UseGuards(guard) @Process() handle() {
        seen.push('handler');
      }
    }
    @Module({ providers: [Consumer] })
    class App {}
    const app = await VelaFactory.create(App);
    await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job)).rejects.toThrow();
    expect(constructed).toBe(0);
    expect(seen).toEqual(['deferred']);
    await app.close();
  });
});

it('resolves an async guard from the processor owner rather than a neighboring module', async () => {
  const LABEL = new InjectionToken<string>('guard owner label');
  const seen: string[] = [];
  @Injectable()
  class Guard implements CanActivate {
    constructor(@Inject(LABEL) readonly label: string) {}
    canActivate() {
      seen.push(this.label);
      return true;
    }
  }
  @Injectable({ scope: Scope.REQUEST })
  @Processor('owners')
  class Consumer {
    @UseGuards(Guard) @Process() handle() {}
  }
  class Feature {}
  @Module({
    imports: ['left', 'right'].map((key) => ({
      module: Feature,
      key,
      providers: [
        Consumer,
        defineProvider(LABEL, { useValue: key }),
        defineProvider(Guard, {
          inject: [LABEL],
          scope: Scope.REQUEST,
          useFactory: async (label) => new Guard(label),
        }),
      ],
    })),
  })
  class App {}
  const app = await VelaFactory.create(App);
  await dispatchQueueJob(app.getContainer(), app.entrypoints, job);
  expect(seen.toSorted()).toEqual(['left', 'right']);
  await app.close();
});

it('routes asynchronous component-construction failures through scoped filters', async () => {
  const claimed: unknown[] = [];
  class GuardFailure extends Error {}
  @Injectable()
  class BrokenGuard {
    canActivate() {
      return true;
    }
  }
  @Catch(GuardFailure)
  @Injectable()
  class Filter {
    catch(error: unknown) {
      claimed.push(error);
    }
  }
  @Processor('owners')
  @Injectable()
  class Consumer {
    @UseGuards(BrokenGuard)
    @UseFilters(Filter)
    @Process()
    handle() {
      throw new Error('guard must prevent invocation');
    }
  }
  @Module({
    providers: [
      Consumer,
      Filter,
      defineProvider(BrokenGuard, {
        inject: [],
        scope: Scope.REQUEST,
        useFactory: async () => {
          throw new GuardFailure('async guard construction');
        },
      }),
    ],
  })
  class App {}
  const app = await VelaFactory.create(App);
  await expect(dispatchQueueJob(app.getContainer(), app.entrypoints, job)).resolves.toEqual({
    handled: 1,
  });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toBeInstanceOf(GuardFailure);
  await app.close();
});
