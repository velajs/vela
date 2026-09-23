import { describe, expect, it } from 'vitest';
import {
  Container,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Reflector,
  SetMetadata,
  UseGuards,
  VelaFactory,
  defineModule,
  defineProvider,
  lazyProvider,
  type AsyncModuleOptions,
  type CanActivate,
  type ExecutionContext,
} from '../index';

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
