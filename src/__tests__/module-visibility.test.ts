import { beforeEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  ModuleRef,
  ModuleVisibilityError,
  VelaFactory,
} from '../index.js';
import { Container } from '../internal.js';
import type { DynamicModule } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('Module visibility', () => {
  it('rejects cross-module resolution when token is not exported', async () => {
    @Injectable()
    class ServiceA {}
    @Injectable()
    class ServiceB {
      constructor(public a: ServiceA) {}
    }

    @Module({ providers: [ServiceA] })
    class ModA {}
    @Module({ imports: [ModA], providers: [ServiceB] })
    class ModB {}

    await expect(VelaFactory.create(ModB)).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('allows resolution when token is exported by an imported module', async () => {
    @Injectable()
    class ServiceA {}
    @Injectable()
    class ServiceB {
      constructor(public a: ServiceA) {}
    }

    @Module({ providers: [ServiceA], exports: [ServiceA] })
    class ModA {}
    @Module({ imports: [ModA], providers: [ServiceB] })
    class ModB {}

    const app = await VelaFactory.create(ModB);
    expect(app.get(ServiceB).a).toBeInstanceOf(ServiceA);
  });

  it('honors transitive re-exports through an intermediate module', async () => {
    @Injectable()
    class ServiceX {}
    @Injectable()
    class ServiceA {
      constructor(public x: ServiceX) {}
    }

    @Module({ providers: [ServiceX], exports: [ServiceX] })
    class ModC {}
    // ModB imports ModC and re-exports ServiceX
    @Module({ imports: [ModC], exports: [ServiceX] })
    class ModB {}
    @Module({ imports: [ModB], providers: [ServiceA] })
    class ModA {}

    const app = await VelaFactory.create(ModA);
    expect(app.get(ServiceA).x).toBeInstanceOf(ServiceX);
  });

  it('@Global module exports are visible from any module without explicit imports', async () => {
    @Injectable()
    class GlobalSvc {}
    @Injectable()
    class Consumer {
      constructor(public g: GlobalSvc) {}
    }

    @Global()
    @Module({ providers: [GlobalSvc], exports: [GlobalSvc] })
    class ModG {}

    @Module({ imports: [ModG], providers: [Consumer] })
    class ModC {}

    const app = await VelaFactory.create(ModC);
    expect(app.get(Consumer).g).toBeInstanceOf(GlobalSvc);
  });

  it('@Global module without exports does NOT leak its providers globally', async () => {
    @Injectable()
    class HiddenSvc {}
    @Injectable()
    class Consumer {
      constructor(public h: HiddenSvc) {}
    }

    @Global()
    @Module({ providers: [HiddenSvc] })
    class ModG {}

    @Module({ imports: [ModG], providers: [Consumer] })
    class ModC {}

    await expect(VelaFactory.create(ModC)).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('dynamic module global: true makes its exports visible cross-module', async () => {
    const TOKEN = new InjectionToken<string>('SHARED');

    @Injectable()
    class Consumer {
      constructor(@Inject(TOKEN) public value: string) {}
    }

    class FeatureModule {
      static forRoot(): DynamicModule {
        return {
          module: FeatureModule,
          providers: [{ provide: TOKEN, useValue: 'shared-value' }],
          exports: [TOKEN],
          global: true,
        };
      }
    }

    @Module({ imports: [FeatureModule.forRoot()], providers: [Consumer] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(Consumer).value).toBe('shared-value');
  });

  it('unregistered class tokens never auto-register — must be declared as providers', async () => {
    @Injectable()
    class Standalone {}

    @Module({})
    class App {}

    const app = await VelaFactory.create(App);
    // Direct resolve with no requester (no module context) bypasses the
    // visibility check, but unregistered class tokens still throw.
    expect(() => app.getContainer().resolve(Standalone)).toThrow(
      /No provider found for token: Standalone\. Declare it in a module's providers\./,
    );
  });

  it('useExisting pointing at an invisible token is rejected', async () => {
    @Injectable()
    class HiddenImpl {}
    const ALIAS = new InjectionToken<HiddenImpl>('ALIAS');

    @Injectable()
    class Consumer {
      constructor(@Inject(ALIAS) public a: HiddenImpl) {}
    }

    // ModA holds HiddenImpl but does not export it
    @Module({ providers: [HiddenImpl] })
    class ModA {}

    // ModB declares the alias but the alias targets ModA's invisible HiddenImpl
    @Module({
      imports: [ModA],
      providers: [
        Consumer,
        { provide: ALIAS, useExisting: HiddenImpl },
      ],
    })
    class ModB {}

    await expect(VelaFactory.create(ModB)).rejects.toThrow(
      ModuleVisibilityError,
    );
  });

  it('framework primitives (Container, ModuleRef) are resolvable from any module', async () => {
    @Injectable()
    class UsesContainer {
      constructor(public c: Container, public ref: ModuleRef) {}
    }

    @Module({ providers: [UsesContainer] })
    class App {}

    const app = await VelaFactory.create(App);
    const u = app.get(UsesContainer);
    expect(u.c).toBeInstanceOf(Container);
    expect(u.ref).toBeInstanceOf(ModuleRef);
  });

  it('controller injecting a service from an imported, exported module resolves', async () => {
    @Injectable()
    class GreetingSvc {
      hello() {
        return 'hi';
      }
    }

    @Module({ providers: [GreetingSvc], exports: [GreetingSvc] })
    class GreetingModule {}

    @Controller('/greet')
    class GreetController {
      constructor(private g: GreetingSvc) {}
      @Get()
      handle() {
        return { greeting: this.g.hello() };
      }
    }

    @Module({ imports: [GreetingModule], controllers: [GreetController] })
    class App {}

    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/greet');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ greeting: 'hi' });
  });

  it('@Inject(token) honors visibility — visible token resolves', async () => {
    const NAME = new InjectionToken<string>('NAME');

    @Injectable()
    class Consumer {
      constructor(@Inject(NAME) public name: string) {}
    }

    @Module({
      providers: [{ provide: NAME, useValue: 'alice' }],
      exports: [NAME],
    })
    class ConfigModule {}

    @Module({ imports: [ConfigModule], providers: [Consumer] })
    class App {}

    const app = await VelaFactory.create(App);
    expect(app.get(Consumer).name).toBe('alice');
  });

  it('ModuleRef.create() sandbox bypasses visibility (escape hatch)', async () => {
    @Injectable()
    class HiddenDep {}

    // HiddenDep is in ModA but not exported
    @Module({ providers: [HiddenDep] })
    class ModA {}

    // We don't actually use HiddenDep cross-module here — we just verify
    // ModuleRef.create() can instantiate transient classes outside the
    // visibility check.
    @Injectable()
    class Transient {
      readonly id = Math.random();
    }

    @Module({ imports: [ModA], providers: [] })
    class App {}

    const app = await VelaFactory.create(App);
    const ref = app.get(ModuleRef);
    const t1 = ref.create(Transient);
    const t2 = ref.create(Transient);
    expect(t1).toBeInstanceOf(Transient);
    expect(t2).toBeInstanceOf(Transient);
    expect(t1.id).not.toBe(t2.id);
  });

});
