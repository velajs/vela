import { describe, expect, it } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  Module,
  ModuleRef,
  Optional,
  defineProvider,
  forwardRef,
  type DynamicModule,
} from '../index';
import { bootstrap } from '../factory/bootstrap';
import { finalizeApplication } from '../factory/finalize';

// The two bootstrap seams @velajs/testing builds overrideModule() and
// useMocker() on: module substitution while the graph loads, and supplying the
// dependencies no provider satisfies before anything is constructed.
describe('module overrides', () => {
  const GREETING = new InjectionToken<string>('greeting');

  @Module({ providers: [defineProvider(GREETING, { useValue: 'real' })], exports: [GREETING] })
  class RealModule {}

  @Module({ providers: [defineProvider(GREETING, { useValue: 'fake' })], exports: [GREETING] })
  class FakeModule {}

  @Injectable()
  class Greeter {
    constructor(@Inject(GREETING) readonly greeting: string) {}
  }

  it('loads the replacement wherever the graph imports the module', async () => {
    @Module({ imports: [RealModule], providers: [Greeter] })
    class Feature {}
    @Module({ imports: [RealModule, Feature], providers: [] })
    class App {}

    const prepared = await bootstrap(
      App,
      {},
      { moduleOverrides: new Map([[RealModule, FakeModule]]) },
    );
    const app = await finalizeApplication(prepared);
    try {
      expect(app.get(Greeter).greeting).toBe('fake');
      const modules = app
        .getContainer()
        .getModuleDescriptions()
        .map((module) => module.moduleId);
      expect(modules).toContain('FakeModule#default');
      expect(modules).not.toContain('RealModule#default');
    } finally {
      await app.dispose();
    }
  });

  it('matches dynamic and forwardRef imports of the overridden class, and re-exports', async () => {
    const dynamic: DynamicModule = { module: RealModule, providers: [] };
    const replacement: DynamicModule = {
      module: FakeModule,
      providers: [defineProvider(GREETING, { useValue: 'dynamic fake' })],
      exports: [GREETING],
    };
    @Module({ imports: [dynamic], exports: [RealModule] })
    class Reexporter {}
    @Module({ imports: [forwardRef(() => Reexporter)], providers: [Greeter] })
    class App {}

    const prepared = await bootstrap(
      App,
      {},
      { moduleOverrides: new Map([[RealModule, replacement]]) },
    );
    const app = await finalizeApplication(prepared);
    try {
      expect(app.get(Greeter).greeting).toBe('dynamic fake');
    } finally {
      await app.dispose();
    }
  });

  it('leaves the module metadata untouched for the next application', async () => {
    @Module({ imports: [RealModule], providers: [Greeter] })
    class App {}

    const overridden = await finalizeApplication(
      await bootstrap(App, {}, { moduleOverrides: new Map([[RealModule, FakeModule]]) }),
    );
    const plain = await finalizeApplication(await bootstrap(App));
    try {
      expect(overridden.get(Greeter).greeting).toBe('fake');
      expect(plain.get(Greeter).greeting).toBe('real');
    } finally {
      await overridden.dispose();
      await plain.dispose();
    }
  });
});

describe('supplying missing dependencies', () => {
  const CLOCK = new InjectionToken<{ now(): number }>('clock');
  const DEFAULTED = new InjectionToken<string>('defaulted', { factory: () => 'default' });
  const OPTIONAL = new InjectionToken<string>('optional');

  @Injectable()
  class Mailer {
    send(): string {
      return 'sent';
    }
  }

  @Injectable()
  class Signup {
    constructor(
      readonly mailer: Mailer,
      @Inject(CLOCK) readonly clock: { now(): number },
      @Inject(DEFAULTED) readonly defaulted: string,
      @Optional() @Inject(OPTIONAL) readonly optional: string | undefined,
      readonly moduleRef: ModuleRef,
    ) {}
  }

  const REPORT = new InjectionToken<string>('report');

  it('registers one supplied value per missing token in every module that needs it', async () => {
    @Module({
      providers: [
        Signup,
        defineProvider(REPORT, {
          useFactory: (clock: { now(): number }) => `at ${clock.now()}`,
          inject: [CLOCK],
        }),
      ],
    })
    class Accounts {}
    @Injectable()
    class Billing {
      constructor(readonly mailer: Mailer) {}
    }
    @Module({ imports: [Accounts], providers: [Billing] })
    class App {}

    const prepared = await bootstrap(App);
    const requested: unknown[] = [];
    prepared.container.supplyMissingDependencies((token) => {
      requested.push(token);
      return token === CLOCK ? { now: () => 42 } : { send: () => 'mocked' };
    });
    const app = await finalizeApplication(prepared);
    try {
      expect(requested).toEqual([Mailer, CLOCK]);
      const signup = app.get(Signup);
      expect(signup.mailer.send()).toBe('mocked');
      expect(signup.clock.now()).toBe(42);
      expect(signup.defaulted).toBe('default');
      expect(signup.optional).toBeUndefined();
      expect(signup.moduleRef).toBeInstanceOf(ModuleRef);
      expect(app.get(Billing).mailer).toBe(signup.mailer);
      expect(app.get(REPORT)).toBe('at 42');
    } finally {
      await app.dispose();
    }
  });

  it('supplies nothing when every dependency is provided', async () => {
    @Module({
      providers: [Signup, Mailer, defineProvider(CLOCK, { useValue: { now: () => 1 } })],
    })
    class App {}

    const prepared = await bootstrap(App);
    const requested: unknown[] = [];
    prepared.container.supplyMissingDependencies((token) => requested.push(token));
    const app = await finalizeApplication(prepared);
    try {
      expect(requested).toEqual([]);
      expect(app.get(Signup).mailer).toBeInstanceOf(Mailer);
    } finally {
      await app.dispose();
    }
  });
});
