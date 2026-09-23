import { describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Container,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Reflector,
  Scope,
  SetMetadata,
  UseGuards,
  VelaFactory,
  defineModule,
  defineProvider,
  lazyProvider,
  type AsyncModuleOptions,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
  Catch,
  Global,
  forwardRef,
} from '../index';
import { getScope, isInjectable } from '../container/decorators';
import { LiveResolver } from '../live/index';
import { Processor } from '../queue/index';

const COUNT = new InjectionToken<number>('authoring count');
const LABEL = new InjectionToken<string>('authoring label');

const Roles = (...roles: string[]) => SetMetadata('roles', roles);

@Injectable()
class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>('roles', context);
    return !roles || roles.includes(context.getRequest().headers.get('x-role') ?? '');
  }
}

describe('Reflector', () => {
  it('is injectable from any module without a providers entry', async () => {
    @Controller('/admin')
    @UseGuards(RolesGuard)
    class AdminController {
      @Roles('admin')
      @Get()
      index() {
        return { ok: true };
      }
    }

    @Module({ providers: [RolesGuard], controllers: [AdminController] })
    class AdminModule {}

    @Module({ imports: [AdminModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    expect((await hono.request('/admin')).status).toBe(403);
    expect((await hono.request('/admin', { headers: { 'x-role': 'admin' } })).status).toBe(200);
    expect(app.get(Reflector)).toBeInstanceOf(Reflector);
    await app.close();
  });
});

describe('zero-argument factories', () => {
  it('need no inject tuple in providers, lazy providers and async module options', async () => {
    const container = new Container().register(defineProvider(COUNT, { useFactory: () => 2 }));
    const THUNK = new InjectionToken<() => string>('authoring thunk');
    container.register(lazyProvider({ provide: THUNK, useFactory: () => 'built' }));
    const options: AsyncModuleOptions<{ size: number }> = { useFactory: () => ({ size: 1 }) };

    expect(container.resolve(COUNT)).toBe(2);
    expect(container.resolve(THUNK)()).toBe('built');
    expect(await options.useFactory()).toEqual({ size: 1 });

    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<{ size: number }>({
      name: 'ZeroArgument',
      setup: ({ OPTIONS }) => ({ exports: [OPTIONS] }),
    });
    class SizeModule extends ConfigurableModuleClass {}

    @Injectable()
    class SizeReader {
      constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: { size: number }) {}
    }

    @Module({
      imports: [SizeModule.forRootAsync({ useFactory: async () => ({ size: 3 }) })],
      providers: [SizeReader],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(SizeReader).options).toEqual({ size: 3 });
    await app.close();
  });

  it('keep literal option types, with or without an empty inject tuple', async () => {
    type Mode = { mode: 'strict' | 'loose' };
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<Mode>({
      name: 'LiteralOptions',
      setup: ({ OPTIONS }) => ({ exports: [OPTIONS] }),
    });
    class ModeModule extends ConfigurableModuleClass {}
    const omitted: AsyncModuleOptions<Mode> = { useFactory: () => ({ mode: 'strict' }) };
    const empty: AsyncModuleOptions<Mode> = { inject: [], useFactory: () => ({ mode: 'loose' }) };

    @Injectable()
    class ModeReader {
      constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: Mode) {}
    }

    for (const imported of [
      ModeModule.forRootAsync({ useFactory: () => ({ mode: 'strict' }) }),
      ModeModule.forRootAsync({ inject: [], useFactory: async () => ({ mode: 'strict' }) }),
    ]) {
      @Module({ imports: [imported], providers: [ModeReader] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      expect(app.get(ModeReader).options).toEqual({ mode: 'strict' });
      await app.close();
    }
    expect([await omitted.useFactory(), await empty.useFactory()]).toEqual([
      { mode: 'strict' },
      { mode: 'loose' },
    ]);
  });

  it('throws, naming the token, when a factory declares parameters but no inject', () => {
    expect(() =>
      // @ts-expect-error A factory that declares parameters needs the tokens that supply them.
      defineProvider(LABEL, { useFactory: (count: number) => count.toFixed() }),
    ).toThrow(/InjectionToken\(authoring label\).*inject/);

    expect(() =>
      lazyProvider({
        provide: new InjectionToken<() => string>('authoring lazy label'),
        // @ts-expect-error Lazy factories follow the same rule.
        useFactory: (count: number) => count.toFixed(),
      }),
    ).toThrow(/InjectionToken\(authoring lazy label\).*inject/);

    const { ConfigurableModuleClass } = defineModule<{ size: number }>({ name: 'MissingInject' });
    expect(() =>
      ConfigurableModuleClass.forRootAsync({
        // @ts-expect-error Async module factories follow the same rule.
        useFactory: (size: number) => ({ size }),
      }),
    ).toThrow(/MissingInject_MODULE_OPTIONS.*inject/);
  });
});

@Injectable()
class Clock {
  now(): number {
    return Date.now();
  }
}

@Injectable()
class FixedClock extends Clock {
  override now(): number {
    return 42;
  }
}

describe('provider literals', () => {
  it('register { provide, useX } literals listed in @Module({ providers })', async () => {
    const ALIAS = new InjectionToken<number>('authoring alias');

    @Injectable({ scope: Scope.REQUEST })
    class RequestState {}

    @Module({
      providers: [
        { provide: COUNT, useValue: 7 },
        { provide: LABEL, useFactory: () => 'label' },
        { provide: Clock, useClass: FixedClock },
        { provide: ALIAS, useExisting: COUNT },
        { provide: RequestState, useClass: RequestState, scope: Scope.TRANSIENT },
      ],
      exports: [COUNT],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(app.get(COUNT)).toBe(7);
    expect(app.get(LABEL)).toBe('label');
    expect(app.get(Clock).now()).toBe(42);
    expect(app.get(ALIAS)).toBe(7);
    // A literal's scope overrides the class declaration, as with defineProvider.
    expect(app.get(RequestState)).not.toBe(app.get(RequestState));
    await app.close();
  });

  it('accept APP_* literals and computed contributions', async () => {
    const calls: string[] = [];

    @Injectable()
    class CountingGuard implements CanActivate {
      canActivate(): boolean {
        calls.push('guard');
        return true;
      }
    }

    const { ConfigurableModuleClass } = defineModule<{ label: string }>({
      name: 'LiteralContributions',
      setup: ({ options }) => ({
        providers: [{ provide: LABEL, useValue: options.label ?? 'none' }],
        exports: [LABEL],
      }),
    });
    class LabelModule extends ConfigurableModuleClass {}

    @Controller('/literal')
    class LiteralController {
      constructor(@Inject(LABEL) private readonly label: string) {}

      @Get()
      index() {
        return { label: this.label };
      }
    }

    @Module({
      imports: [LabelModule.forRoot({ label: 'computed' })],
      providers: [{ provide: APP_GUARD, useClass: CountingGuard }],
      controllers: [LiteralController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const response = await app.getHonoApp().request('/literal');
    expect(await response.json()).toEqual({ label: 'computed' });
    expect(calls).toEqual(['guard']);
    await app.close();
  });

  it('keep literals typed against their token', () => {
    const providers: Provider[] = [{ provide: COUNT, useValue: 1 }];
    // A list that is not one array literal still accepts classes and definitions.
    const optional = (enabled: boolean) =>
      Module({ providers: enabled ? [Clock, defineProvider(COUNT, { useValue: 1 })] : [] });
    // Factories with dependencies use defineProvider, which infers their parameters.
    // @ts-expect-error A literal factory takes no parameters.
    Module({ providers: [{ provide: LABEL, inject: [COUNT], useFactory: (n: number) => `${n}` }] });
    // @ts-expect-error The class must construct the provided token's type.
    Module({ providers: [{ provide: Clock, useClass: RequestScopedLabel }] });
    // @ts-expect-error Aliases keep the token's value type.
    Module({ providers: [{ provide: COUNT, useExisting: LABEL }] });
    expect(providers).toHaveLength(1);
    expect(optional(true)).toBeTypeOf('function');
  });

  it('reject a DynamicModule entry that is not a provider, naming the token', async () => {
    const dynamic = (providers: Provider[]): DynamicModule => ({
      module: class DynamicLiterals {},
      providers,
    });

    @Module({
      // @ts-expect-error A literal without a strategy is not a provider.
      imports: [dynamic([{ provide: COUNT }])],
    })
    class MissingStrategy {}
    await expect(VelaFactory.create(MissingStrategy)).rejects.toThrow(
      /DynamicLiterals\.providers\[0\] \(InjectionToken\(authoring count\)\) is not a provider/,
    );

    @Module({ imports: [dynamic([{ provide: COUNT, useValue: 1, useFactory: () => 2 }])] })
    class TwoStrategies {}
    await expect(VelaFactory.create(TwoStrategies)).rejects.toThrow(
      /InjectionToken\(authoring count\)\) is not a provider/,
    );

    @Module({ imports: [dynamic([{ provide: LABEL, useFactory: (n: number) => `${n}` }])] })
    class MissingInject {}
    await expect(VelaFactory.create(MissingInject)).rejects.toThrow(
      /InjectionToken\(authoring label\).*inject/,
    );
  });
});

@Injectable()
class RequestScopedLabel {
  readonly label = 'label';
}

describe('implied @Injectable', () => {
  @Injectable()
  class Mailer {
    send(): string {
      return 'sent';
    }
  }

  it('lets a discoverable class decorator stand in for @Injectable', () => {
    @Processor('mail')
    class MailJobs {
      constructor(readonly mailer: Mailer) {}
    }

    @LiveResolver()
    class MailLive {
      constructor(readonly mailer: Mailer) {}
    }

    @Catch(Error)
    class MailFilter {
      constructor(readonly mailer: Mailer) {}
      catch(): string {
        return this.mailer.send();
      }
    }

    const container = new Container({ diagnostics: 'throw' });
    container.register(Mailer);
    for (const target of [MailJobs, MailLive, MailFilter]) {
      expect(isInjectable(target)).toBe(true);
      container.register(target);
    }
    expect(container.resolve(MailJobs).mailer.send()).toBe('sent');
    expect(container.resolve(MailLive).mailer).toBe(container.resolve(Mailer));
    expect(container.resolve(MailFilter).catch()).toBe('sent');
  });

  it('keeps an explicit scope whichever class decorator runs first', () => {
    @Processor('first')
    @Injectable({ scope: Scope.REQUEST })
    class ScopeFirst {}

    @Injectable({ scope: Scope.TRANSIENT })
    @Processor('second')
    class ScopeLast {}

    expect(getScope(ScopeFirst)).toBe(Scope.REQUEST);
    expect(getScope(ScopeLast)).toBe(Scope.TRANSIENT);
  });

  it('still reports a registered class that has no class decorator', () => {
    class Undecorated {}
    const container = new Container({ diagnostics: 'throw' });
    expect(() => container.register(Undecorated)).toThrow(/Undecorated is not decorated/);
  });
});

describe('module re-exports', () => {
  @Injectable()
  class DatabaseService {
    query(): string {
      return 'rows';
    }
  }

  @Module({ providers: [DatabaseService], exports: [DatabaseService] })
  class DatabaseModule {}

  @Injectable()
  class Reader {
    constructor(readonly database: DatabaseService) {}
  }

  it('expands an exported module to the tokens it exports', async () => {
    @Module({ imports: [DatabaseModule], exports: [DatabaseModule] })
    class InfraModule {}

    @Module({ imports: [InfraModule], providers: [Reader] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(Reader).database.query()).toBe('rows');
    await app.close();
  });

  it('re-exports a dynamic module by its class, globally from a global module', async () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<{ region: string }>({
      name: 'Region',
      setup: ({ OPTIONS }) => ({ exports: [OPTIONS] }),
    });
    class RegionModule extends ConfigurableModuleClass {}

    @Global()
    @Module({ imports: [RegionModule.forRoot({ region: 'north' })], exports: [RegionModule] })
    class CoreModule {}

    @Injectable()
    class RegionReader {
      constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: { region: string }) {}
    }

    @Module({ providers: [RegionReader] })
    class FeatureModule {}

    @Module({ imports: [CoreModule, FeatureModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(RegionReader).options).toEqual({ region: 'north' });
    await app.close();
  });

  it('rejects re-exporting a module whose exports a forwardRef cycle leaves unknown', async () => {
    @Module({ imports: [forwardRef(() => SecondModule)] })
    class FirstModule {}

    @Module({ imports: [forwardRef(() => FirstModule)], exports: [FirstModule] })
    class SecondModule {}

    await expect(VelaFactory.create(FirstModule)).rejects.toThrow(
      /SecondModule re-exports FirstModule.*forwardRef/,
    );
  });

  it('reports a module export that is not imported through diagnostics', async () => {
    @Module({ exports: [DatabaseModule] })
    class AppModule {}

    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      /AppModule exports 'DatabaseModule'/,
    );
  });
});

describe('module classes', () => {
  it('are constructed through DI and receive lifecycle hooks after their providers', async () => {
    const calls: string[] = [];

    @Injectable()
    class Store implements OnModuleInit {
      onModuleInit(): void {
        calls.push('store:init');
      }
    }

    @Module({ providers: [Store] })
    class StoreModule implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
      constructor(readonly store: Store) {}
      onModuleInit(): void {
        calls.push(`module:init:${this.store instanceof Store}`);
      }
      onApplicationBootstrap(): void {
        calls.push('module:bootstrap');
      }
      onModuleDestroy(): void {
        calls.push('module:destroy');
      }
    }

    const app = await VelaFactory.create(StoreModule);
    expect(app.get(StoreModule).store).toBe(app.get(Store));
    await app.close();
    expect(calls).toEqual(['store:init', 'module:init:true', 'module:bootstrap', 'module:destroy']);
  });

  it('configure() runs on the instance that receives lifecycle hooks', async () => {
    const instances = new Set<object>();

    @Module({})
    class ConfiguredModule implements NestModule, OnModuleInit {
      configure(_consumer: MiddlewareConsumer): void {
        instances.add(this);
      }
      onModuleInit(): void {
        instances.add(this);
      }
    }

    const app = await VelaFactory.create(ConfiguredModule);
    expect(instances.size).toBe(1);
    await app.close();
  });

  it('are built with their lazy module, not at bootstrap', async () => {
    const calls: string[] = [];

    @Injectable()
    class LazyService {}

    @Module({ lazy: true, providers: [LazyService], exports: [LazyService] })
    class LazyFeature implements OnModuleInit {
      onModuleInit(): void {
        calls.push('lazy-module:init');
      }
    }

    @Module({ imports: [LazyFeature] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(calls).toEqual([]);
    await app.materializeLazyModules();
    expect(calls).toEqual(['lazy-module:init']);
    await app.close();
  });
});
