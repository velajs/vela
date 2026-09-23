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
  type Provider,
  Catch,
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
    // Factories with dependencies use defineProvider, which infers their parameters.
    // @ts-expect-error A literal factory takes no parameters.
    Module({ providers: [{ provide: LABEL, inject: [COUNT], useFactory: (n: number) => `${n}` }] });
    // @ts-expect-error The class must construct the provided token's type.
    Module({ providers: [{ provide: Clock, useClass: RequestScopedLabel }] });
    // @ts-expect-error Aliases keep the token's value type.
    Module({ providers: [{ provide: COUNT, useExisting: LABEL }] });
    expect(providers).toHaveLength(1);
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
