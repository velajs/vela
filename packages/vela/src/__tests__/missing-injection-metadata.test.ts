import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Catch,
  Container,
  Inject,
  Injectable,
  InjectionToken,
  MissingInjectionMetadataError,
  Module,
  ModuleRef,
  Optional,
  VelaFactory,
  defineProvider,
  forwardRef,
} from '../index';
import type { ExceptionFilter, MiddlewareConsumer, NestModule } from '../index';

afterEach(() => {
  vi.restoreAllMocks();
});

interface Settings {
  region: string;
}

const VALUE = new InjectionToken<string>('metadata test value');

@Injectable()
class Dependency {}

// Decorators applied as plain calls emit no design:paramtypes — exactly what a
// build without emitDecoratorMetadata (esbuild, a misconfigured bundler) ships.
class NoMetadata {
  constructor(readonly dependency: Dependency) {}
}
Injectable()(NoMetadata);

class PartialInject {
  constructor(
    readonly dependency: Dependency,
    readonly value: string,
  ) {}
}
Inject(VALUE)(PartialInject, undefined, 1);
Injectable()(PartialInject);

describe('MissingInjectionMetadataError', () => {
  it('rejects a decorated class without emitted constructor metadata at registration', () => {
    const container = new Container();
    expect(() => container.register(NoMetadata)).toThrow(MissingInjectionMetadataError);
    expect(() => container.register(NoMetadata)).toThrow(
      'NoMetadata declares 1 constructor parameter but no design:paramtypes were emitted for ' +
        'parameter #0. Enable emitDecoratorMetadata in your build or add @Inject(Token) to parameter #0.',
    );
  });

  it('covers useClass registrations and the synchronous engine', () => {
    const SERVICE = new InjectionToken<NoMetadata>('metadata test service');
    const container = new Container();
    container.register(Dependency);
    expect(() => {
      container.register(defineProvider(SERVICE, { useClass: NoMetadata }));
      container.resolve(SERVICE);
    }).toThrow(MissingInjectionMetadataError);
  });

  it('fails bootstrap on the asynchronous engine', async () => {
    @Module({ providers: [Dependency, NoMetadata] })
    class AppModule {}
    await expect(VelaFactory.create(AppModule)).rejects.toThrow(MissingInjectionMetadataError);
  });

  it('plans classes built by ModuleRef.create() the same way', async () => {
    @Module({ providers: [Dependency] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    const moduleRef = app.get(ModuleRef);
    await expect(moduleRef.create(NoMetadata)).rejects.toThrow(MissingInjectionMetadataError);
    const built = await moduleRef.create(Dependency);
    expect(built).toBeInstanceOf(Dependency);
    await app.close();
  });

  it('counts explicit @Inject indexes into the resolved arity', () => {
    const container = new Container();
    let error: unknown;
    try {
      container.register(PartialInject);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MissingInjectionMetadataError);
    expect(error).toMatchObject({ parameterIndex: 0 });
    expect(String(error)).toContain('add @Inject(Token) to parameter #0');
  });

  it('rejects a parameter that resolved to Object without @Inject', () => {
    @Injectable()
    class UsesInterface {
      constructor(
        readonly dependency: Dependency,
        readonly settings: Settings,
      ) {}
    }
    const container = new Container();
    let error: unknown;
    try {
      container.register(UsesInterface);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MissingInjectionMetadataError);
    expect(error).toMatchObject({ parameterIndex: 1 });
    expect(String(error)).toContain(
      'UsesInterface declares 2 constructor parameters but parameter #1 resolved to Object',
    );
    expect(String(error)).toContain('add @Inject(Token) to parameter #1');
    expect(String(error)).toContain('import type');
  });

  it('keeps @Optional parameters without a token undefined', () => {
    @Injectable()
    class OptionalSettings {
      constructor(@Optional() readonly settings?: Settings) {}
    }
    const container = new Container();
    container.register(OptionalSettings);
    expect(container.resolve(OptionalSettings).settings).toBeUndefined();
  });

  it('accepts explicit tokens and forwardRef without emitted metadata', async () => {
    class Explicit {
      constructor(
        readonly value: string,
        readonly later: Later,
      ) {}
    }
    Inject(VALUE)(Explicit, undefined, 0);
    Inject(forwardRef(() => Later))(Explicit, undefined, 1);
    Injectable()(Explicit);
    @Injectable()
    class Later {}

    const container = new Container();
    container.register(defineProvider(VALUE, { useValue: 'configured' }));
    container.register(Later);
    container.register(Explicit);
    const sync = container.resolve(Explicit);
    expect(sync.value).toBe('configured');
    expect(sync.later).toBeInstanceOf(Later);

    const asyncContainer = new Container();
    asyncContainer.register(defineProvider(VALUE, { useValue: 'configured' }));
    asyncContainer.register(Later);
    asyncContainer.register(Explicit);
    const resolved = await asyncContainer.resolveAsync(Explicit);
    expect(resolved.later).toBeInstanceOf(Later);
  });
});

describe('inherited constructor metadata', () => {
  @Injectable()
  class Base {
    constructor(
      readonly dependency: Dependency,
      @Inject(VALUE) readonly value: string,
    ) {}
  }

  it('resolves a subclass without its own constructor through the parent metadata', async () => {
    @Injectable()
    class Derived extends Base {}

    const container = new Container();
    container.register(Dependency);
    container.register(defineProvider(VALUE, { useValue: 'inherited' }));
    container.register(Derived);
    const sync = container.resolve(Derived);
    expect(sync.dependency).toBeInstanceOf(Dependency);
    expect(sync.value).toBe('inherited');

    @Module({
      providers: [Dependency, defineProvider(VALUE, { useValue: 'async' }), Derived],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    expect(app.get(Derived).dependency).toBeInstanceOf(Dependency);
    expect(app.get(Derived).value).toBe('async');
    await app.close();
  });

  it('uses the subclass metadata when it declares its own constructor', () => {
    @Injectable()
    class Other {}
    @Injectable()
    class Child extends Base {
      constructor(readonly other: Other) {
        super(new Dependency(), 'fixed');
      }
    }
    const container = new Container();
    container.register(Other);
    container.register(Child);
    const child = container.resolve(Child);
    expect(child.other).toBeInstanceOf(Other);
    expect(child.value).toBe('fixed');
  });
});

describe('registration diagnostics', () => {
  class Undecorated {}

  it('routes a provider without any class decorator through the diagnostics policy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Container({ diagnostics: 'throw' }).register(Undecorated)).toThrow(
      /Undecorated is not decorated with @Injectable\(\)/,
    );

    new Container({ diagnostics: 'silent' }).register(Undecorated);
    expect(warn).not.toHaveBeenCalled();

    new Container({ diagnostics: 'log' }).register(Undecorated);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Undecorated is not decorated with @Injectable\(\)/),
    );
  });

  it('treats module and exception filter classes as decorated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    @Catch()
    class AllErrors implements ExceptionFilter {
      catch(): Response {
        return new Response('handled', { status: 500 });
      }
    }

    @Module({ providers: [AllErrors] })
    class AppModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        void consumer;
      }
    }

    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    await app.close();
    const logged = await VelaFactory.create(AppModule);
    await logged.close();
    expect(warn).not.toHaveBeenCalled();
  });

  it('routes an unknown export through the diagnostics policy', async () => {
    const UNKNOWN = new InjectionToken<string>('never provided');
    @Module({ exports: [UNKNOWN] })
    class Exporter {}

    await expect(VelaFactory.create(Exporter, { diagnostics: 'throw' })).rejects.toThrow(
      /Exporter exports 'InjectionToken\(never provided\)'/,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const silent = await VelaFactory.create(Exporter, { diagnostics: 'silent' });
    await silent.close();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('undecorated classes', () => {
  // A class the application does not own ships without decorators or emitted
  // metadata. Like Nest, the container constructs it with no arguments.
  class SdkClient {
    readonly endpoint: string;
    constructor(options?: { endpoint?: string }) {
      this.endpoint = options?.endpoint ?? 'https://api.invalid';
    }
  }
  const CLIENT = new InjectionToken<SdkClient>('sdk client');
  const EVENTS = new InjectionToken<EventEmitter>('event emitter');

  it('constructs third-party useClass providers with no arguments', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({
      providers: [
        defineProvider(CLIENT, { useClass: SdkClient }),
        defineProvider(EVENTS, { useClass: EventEmitter }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(CLIENT).endpoint).toBe('https://api.invalid');
    expect(app.get(EVENTS)).toBeInstanceOf(EventEmitter);
    await app.close();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SdkClient declares 1 constructor parameter but has no class'),
    );
  });

  it('reports an undecorated class that declares constructor parameters', () => {
    class Reporter {
      constructor(readonly dependency?: Dependency) {}
    }
    const expected =
      '[vela] Reporter declares 1 constructor parameter but has no class decorator, so the ' +
      'build emitted no metadata for it and it is constructed with `new Reporter()`. Decorate ' +
      'it with @Injectable() to inject its parameters, or provide it with useFactory when you ' +
      'do not own the class.';

    expect(() => new Container({ diagnostics: 'throw' }).register(Reporter)).toThrow(expected);
    const REPORTER = new InjectionToken<Reporter>('reporter');
    expect(() =>
      new Container({ diagnostics: 'throw' }).register(
        defineProvider(REPORTER, { useClass: Reporter }),
      ),
    ).toThrow(expected);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = new Container();
    container.register(Dependency);
    container.register(Reporter);
    expect(warn).toHaveBeenCalledWith(expected);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('emitDecoratorMetadata'));
    expect(container.resolve(Reporter).dependency).toBeUndefined();
  });
});
