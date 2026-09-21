import { expect, it } from 'vitest';
import {
  EXECUTION_LIFETIME,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
  defineProvider,
  type ExecutionLifetime,
} from '../../index';
import { Seeder, SeederModule, SeederRegistry, runSeeders } from '../../seeder';

it('runs async owned seeders and deferred work in isolated Workers invocation scopes', async () => {
  const NAME = new InjectionToken<string>('native seeder name');
  const observed: string[] = [];
  const lifetimes: ExecutionLifetime[] = [];
  @Seeder()
  class Seed {
    readonly #name: string;
    readonly #lifetime: ExecutionLifetime;
    constructor(name: string, lifetime: ExecutionLifetime) {
      this.#name = name;
      this.#lifetime = lifetime;
      lifetimes.push(lifetime);
    }
    run() {
      observed.push(this.#name);
      this.#lifetime.defer(async () => {
        await Promise.resolve();
        observed.push(`${this.#name}:deferred`);
      });
    }
    dispose() {
      observed.push(`${this.#name}:disposed`);
    }
  }
  class Feature {}
  @Module({
    imports: [
      SeederModule,
      ...['one', 'two'].map((key) => ({
        module: Feature,
        key,
        lazy: true,
        providers: [
          defineProvider(NAME, { useValue: key }),
          defineProvider(Seed, {
            scope: Scope.REQUEST,
            inject: [NAME, EXECUTION_LIFETIME],
            useFactory: async (name, lifetime) => {
              await Promise.resolve();
              return new Seed(name, lifetime);
            },
          }),
        ],
      })),
    ],
  })
  class Root {}
  const app = await VelaFactory.create(Root);
  try {
    expect(
      app
        .get(SeederRegistry)
        .list()
        .map((entry) => entry.moduleId),
    ).toEqual(['Feature#one', 'Feature#two']);
    expect(lifetimes).toHaveLength(0);
    expect((await runSeeders(app)).every((result) => result.ok)).toBe(true);
    expect(observed).toEqual([
      'one',
      'one:deferred',
      'one:disposed',
      'two',
      'two:deferred',
      'two:disposed',
    ]);
    expect(lifetimes[0]?.id).not.toBe(lifetimes[1]?.id);
    expect(lifetimes.every((lifetime) => !lifetime.active)).toBe(true);
  } finally {
    await app.dispose();
  }
});
