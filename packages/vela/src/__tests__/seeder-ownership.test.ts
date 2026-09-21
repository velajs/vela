import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LIFETIME,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
  defineProvider,
  type ExecutionLifetime,
} from '../index';
import { Seeder, SeederModule, SeederRegistry, runSeeders } from '../seeder';

describe('owned seeder invocations', () => {
  it('preserves registration order for equal priorities, independent of decorator declaration order', async () => {
    const calls: string[] = [];
    @Seeder()
    class DeclaredFirst {
      run() {
        calls.push('first');
      }
    }
    @Seeder()
    class DeclaredSecond {
      run() {
        calls.push('second');
      }
    }
    @Module({ imports: [SeederModule], providers: [DeclaredSecond, DeclaredFirst] })
    class Root {}
    const app = await VelaFactory.create(Root);
    try {
      const registry = app.get(SeederRegistry);
      const inventory = registry.list();
      if (inventory[0]) inventory[0].name = 'mutated outside the registry';
      expect(registry.list()[0]?.name).toBe('DeclaredSecond');
      expect((await runSeeders(app)).every((result) => result.ok)).toBe(true);
      expect(calls).toEqual(['second', 'first']);
    } finally {
      await app.dispose();
    }
  });

  it('rejects malformed custom provider values at invocation rather than pretending they are seeders', async () => {
    @Seeder()
    class Declared {
      run() {}
    }
    const invalid = Object.defineProperty(new Declared(), 'run', { value: false });
    @Module({
      imports: [SeederModule],
      providers: [defineProvider(Declared, { useValue: invalid })],
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    try {
      const results = await runSeeders(app);
      expect(results[0]?.ok).toBe(false);
      expect(results[0]?.error).toBeInstanceOf(TypeError);
      expect(String(results[0]?.error)).toContain('must provide run()');
    } finally {
      await app.dispose();
    }
  });

  it('lists lazy owners without construction, then awaits each async factory and deferred work before disposal', async () => {
    const events: string[] = [];
    const NAME = new InjectionToken<string>('seeder owner label');
    const lifetimes: ExecutionLifetime[] = [];
    @Seeder({ name: 'shared' })
    class SharedSeeder {
      readonly #name: string;
      readonly #lifetime: ExecutionLifetime;
      constructor(name: string, lifetime: ExecutionLifetime) {
        this.#name = name;
        this.#lifetime = lifetime;
        lifetimes.push(lifetime);
        events.push(`${name}:construct`);
      }
      run() {
        events.push(`${this.#name}:run`);
        this.#lifetime.defer(async () => {
          await Promise.resolve();
          events.push(`${this.#name}:defer`);
        });
      }
      dispose() {
        events.push(`${this.#name}:dispose`);
      }
    }
    class Feature {}
    for (const environment of ['development', 'test']) {
      @Module({
        imports: [
          SeederModule,
          ...['one', 'two'].map((key) => ({
            module: Feature,
            key,
            lazy: true,
            providers: [
              defineProvider(NAME, { useValue: `${environment}:${key}` }),
              defineProvider(SharedSeeder, {
                scope: Scope.REQUEST,
                inject: [NAME, EXECUTION_LIFETIME],
                useFactory: async (name, lifetime) => {
                  await Promise.resolve();
                  return new SharedSeeder(name, lifetime);
                },
              }),
            ],
          })),
        ],
      })
      class Root {}
      const app = await VelaFactory.create(Root);
      try {
        const registry = app.get(SeederRegistry);
        expect(registry.list().map((entry) => [entry.name, entry.moduleId])).toEqual([
          ['shared', 'Feature#one'],
          ['shared', 'Feature#two'],
        ]);
        expect(events).toHaveLength(0);
        // Bootstrap replay must replace the inventory rather than append duplicates.
        registry.onApplicationBootstrap();
        expect(registry.list()).toHaveLength(2);
        expect(await runSeeders(app)).toEqual([
          { name: 'shared', ok: true },
          { name: 'shared', ok: true },
        ]);
        expect(events).toEqual(
          ['one', 'two'].flatMap((owner) =>
            ['construct', 'run', 'defer', 'dispose'].map(
              (step) => `${environment}:${owner}:${step}`,
            ),
          ),
        );
        expect(new Set(lifetimes.map((lifetime) => lifetime.id)).size).toBe(lifetimes.length);
        expect(lifetimes.every((lifetime) => !lifetime.active)).toBe(true);
      } finally {
        await app.dispose();
      }
      events.length = 0;
    }
  });

  it('captures handler and managed-completion failures, then honors stop or continue', async () => {
    const primary = new Error('seeder failed');
    const deferred = new Error('deferred failed');
    let released = 0;
    let nextRuns = 0;
    @Injectable({ scope: Scope.REQUEST })
    @Seeder({ order: 0 })
    class Failing {
      constructor(@Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime) {}
      run() {
        this.lifetime.defer(() => {
          throw deferred;
        });
        throw primary;
      }
      dispose() {
        released++;
      }
    }
    @Seeder({ order: 1 })
    class Next {
      run() {
        nextRuns++;
      }
    }
    @Module({ imports: [SeederModule], providers: [Failing, Next] })
    class Root {}
    const app = await VelaFactory.create(Root);
    try {
      for (const stopOnError of [true, false]) {
        const results = await runSeeders(app, { stopOnError });
        expect(results).toHaveLength(stopOnError ? 1 : 2);
        expect(results[0]?.ok).toBe(false);
        expect(results[0]?.error).toBeInstanceOf(AggregateError);
        const error = results[0]?.error;
        if (error instanceof AggregateError) expect(error.errors).toEqual([primary, deferred]);
      }
      expect(nextRuns).toBe(1);
      expect(released).toBe(2);
    } finally {
      await app.dispose();
    }
  });
});
