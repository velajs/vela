import { describe, expect, expectTypeOf, it } from 'vitest';
import * as vela from '../index.js';
import {
  Controller,
  ENV,
  Get,
  Global,
  Injectable,
  InjectEnv,
  InjectionToken,
  InternalDispatcher,
  Module,
  MultipleProvidersFoundError,
  Optional,
  Post,
  SignedInvocation,
  SignedUrl,
  URL_SIGNING_SECRET,
  UrlGeneratorService,
  VelaFactory,
  bootstrap,
  defineProvider,
  type RuntimeAdapter,
  type VelaEnv,
} from '../index.js';

/** Read one synthetic string binding the way framework readers do. */
function binding(env: VelaEnv, key: string): string | undefined {
  const value: unknown = Reflect.get(env, key);
  return typeof value === 'string' ? value : undefined;
}

function featureApp() {
  @Injectable()
  class Greeter {
    constructor(@InjectEnv() readonly env: VelaEnv) {}
    greet(): string {
      return `hello ${binding(this.env, 'NAME') ?? 'nobody'}`;
    }
  }
  // ENV is global: a non-root feature module injects it without importing anything.
  @Module({ providers: [Greeter], exports: [Greeter] })
  class FeatureModule {}
  @Module({ imports: [FeatureModule] })
  class AppModule {}
  return { AppModule, Greeter };
}

describe('framework-owned ENV', () => {
  it('seeds ENV from the env option and injects it with @InjectEnv() in any module', async () => {
    const { AppModule, Greeter } = featureApp();
    const env = { NAME: 'edge' };
    const app = await VelaFactory.create(AppModule, { env });

    expect(app.get(ENV)).toBe(env);
    expectTypeOf(app.get(ENV)).toEqualTypeOf<VelaEnv>();
    expect(app.get(Greeter).greet()).toBe('hello edge');
    await app.close();
  });

  it('has no default: an unseeded ENV fails a required read and is undefined when optional', async () => {
    @Injectable()
    class OptionalReader {
      constructor(@Optional() @InjectEnv() readonly env?: VelaEnv) {}
    }
    @Module({ providers: [OptionalReader] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(() => app.get(ENV)).toThrow(/No provider found for token/);
    expect(app.get(OptionalReader).env).toBeUndefined();
    await app.close();
  });

  it('keeps two environments isolated across two applications built from one root module', async () => {
    const { AppModule, Greeter } = featureApp();
    const a = { NAME: 'a' };
    const b = { NAME: 'b' };
    const [first, second] = await Promise.all([
      VelaFactory.create(AppModule, { env: a }),
      VelaFactory.create(AppModule, { env: b }),
    ]);

    expect(first.get(ENV)).toBe(a);
    expect(second.get(ENV)).toBe(b);
    expect(first.get(Greeter).greet()).toBe('hello a');
    expect(second.get(Greeter).greet()).toBe('hello b');
    await Promise.all([first.close(), second.close()]);
  });

  it('lets a runtime adapter seed ENV before providers construct', async () => {
    const { AppModule, Greeter } = featureApp();
    const env = { NAME: 'adapter' };
    const adapter: RuntimeAdapter = {
      name: 'synthetic-runtime',
      configureContainer: (container) => {
        container.register(defineProvider(ENV, { useValue: env }));
      },
    };
    const app = await VelaFactory.create(AppModule, { adapters: [adapter] });

    expect(app.get(ENV)).toBe(env);
    expect(app.get(Greeter).greet()).toBe('hello adapter');
    await app.close();
  });

  it('rejects a non-object env at bootstrap', async () => {
    @Module({})
    class AppModule {}
    const invalid: unknown = 'not-an-environment';
    await expect(
      // @ts-expect-error the option carries the runtime environment object
      bootstrap(AppModule, { env: invalid }),
    ).rejects.toThrow(TypeError);
  });

  it('is exported as a typed token next to InjectEnv, replacing the removed env re-exports', () => {
    expect(ENV).toBeInstanceOf(InjectionToken);
    expectTypeOf(ENV).toEqualTypeOf<InjectionToken<VelaEnv>>();
    expect(ENV.options?.factory).toBeUndefined();
    const exported = Object.keys(vela);
    expect(exported).toContain('InjectEnv');
    // ENV is the only environment token; the config layer exports no second one.
    expect(exported.filter((name) => name.endsWith('_ENV'))).toEqual([]);
    // Hono's `env()` adapter helper is confusable with ENV; core no longer re-exports it.
    expect(exported).not.toContain('env');
    expect(exported).not.toContain('getRuntimeKey');
  });
});

describe('signing secrets from ENV', () => {
  function signingApp() {
    @Controller('/files')
    class FilesController {
      @Get('download', { name: 'file.download' })
      @SignedUrl()
      download() {
        return { ok: true };
      }

      @Post('invoke', { name: 'file.invoke' })
      @SignedInvocation()
      invoke() {
        return { invoked: true };
      }
    }
    @Module({ controllers: [FilesController] })
    class AppModule {}
    return AppModule;
  }

  it('signs and verifies URLs with URL_SIGNING_SECRET from ENV', async () => {
    const app = await VelaFactory.create(signingApp(), {
      env: { URL_SIGNING_SECRET: 'env-signing-secret' },
    });
    const signed = await app
      .get(UrlGeneratorService)
      .signedUrl('file.download', {}, { expiresIn: 60 });

    expect((await app.getHonoApp().request(signed)).status).toBe(200);
    await app.close();
  });

  it('dispatches signed invocations with URL_SIGNING_SECRET from ENV', async () => {
    const app = await VelaFactory.create(signingApp(), {
      env: { URL_SIGNING_SECRET: 'env-signing-secret' },
    });

    await expect(app.get(InternalDispatcher).run({ route: 'file.invoke' })).resolves.toEqual({
      invoked: true,
    });
    await app.close();
  });

  it('ignores a non-string ENV secret instead of signing with it', async () => {
    const app = await VelaFactory.create(signingApp(), {
      env: { URL_SIGNING_SECRET: 42 },
    });

    await expect(
      app.get(UrlGeneratorService).signedUrl('file.download', {}, { expiresIn: 60 }),
    ).rejects.toThrow(/No URL signing secret/);
    await app.close();
  });

  it('reads ENV from the one @Global() module that exports it, application-wide', async () => {
    const moduleEnv = { URL_SIGNING_SECRET: 'module-signing-secret' };

    @Global()
    @Module({ providers: [defineProvider(ENV, { useValue: moduleEnv })], exports: [ENV] })
    class EnvModule {}

    @Module({ imports: [EnvModule, signingApp()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const verifier = await VelaFactory.create(signingApp(), { env: moduleEnv });
    const signed = await app
      .get(UrlGeneratorService)
      .signedUrl('file.download', {}, { expiresIn: 60 });

    expect(app.get(ENV)).toBe(moduleEnv);
    // The application's UrlGeneratorService signs with the module's ENV.
    expect((await verifier.getHonoApp().request(signed)).status).toBe(200);
    await Promise.all([app.close(), verifier.close()]);
  });

  it('prefers the ENV the application seeds over a @Global() module, application-wide', async () => {
    const seeded = { URL_SIGNING_SECRET: 'bootstrap-signing-secret', NAME: 'bootstrap' };
    const { AppModule: FeatureApp, Greeter } = featureApp();

    @Global()
    @Module({
      providers: [defineProvider(ENV, { useValue: { NAME: 'module' } })],
      exports: [ENV],
    })
    class EnvModule {}

    @Module({ imports: [EnvModule, FeatureApp, signingApp()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { env: seeded });
    const verifier = await VelaFactory.create(signingApp(), { env: seeded });
    const signed = await app
      .get(UrlGeneratorService)
      .signedUrl('file.download', {}, { expiresIn: 60 });

    expect(app.get(ENV)).toBe(seeded);
    // The application's UrlGeneratorService signs with the seeded ENV.
    expect((await verifier.getHonoApp().request(signed)).status).toBe(200);
    // A module still reaches the @Global() export before the application's registration.
    expect(app.get(Greeter).greet()).toBe('hello module');
    await Promise.all([app.close(), verifier.close()]);
  });

  it('reports ENV that two @Global() modules export, application-wide too', async () => {
    @Global()
    @Module({ providers: [defineProvider(ENV, { useValue: { NAME: 'first' } })], exports: [ENV] })
    class FirstEnvModule {}

    @Global()
    @Module({ providers: [defineProvider(ENV, { useValue: { NAME: 'second' } })], exports: [ENV] })
    class SecondEnvModule {}

    @Module({ imports: [FirstEnvModule, SecondEnvModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    expect(() => app.get(ENV)).toThrow(MultipleProvidersFoundError);
    await app.close();
  });

  it('prefers an explicit URL_SIGNING_SECRET provider over ENV', async () => {
    @Global()
    @Module({
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'provider-secret' })],
      exports: [URL_SIGNING_SECRET],
    })
    class SecretModule {}
    @Module({ imports: [SecretModule, signingApp()] })
    class AppModule {}
    const provider = await VelaFactory.create(AppModule, {
      env: { URL_SIGNING_SECRET: 'env-signing-secret' },
    });
    const fromEnvOnly = await VelaFactory.create(signingApp(), {
      env: { URL_SIGNING_SECRET: 'env-signing-secret' },
    });
    const signed = await provider
      .get(UrlGeneratorService)
      .signedUrl('file.download', {}, { expiresIn: 60 });

    // A URL signed with the provider secret fails verification under the ENV secret.
    expect((await provider.getHonoApp().request(signed)).status).toBe(200);
    expect((await fromEnvOnly.getHonoApp().request(signed)).status).toBe(403);
    await Promise.all([provider.close(), fromEnvOnly.close()]);
  });
});
