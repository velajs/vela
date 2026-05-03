import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
  forwardRef,
} from '../index.js';
import { METADATA_KEYS } from '../constants.js';
import { defineMetadata } from '../metadata.js';
import type { DynamicModule } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

// =============================================================================
// DynamicModule.imports
// =============================================================================

describe('DynamicModule.imports', () => {
  it('should process imports returned from a register() method', async () => {
    @Injectable()
    class SharedService {
      greet() { return 'hello from shared'; }
    }

    @Module({ providers: [SharedService], exports: [SharedService] })
    class SharedModule {}

    @Injectable()
    class FeatureService {
      constructor(private shared: SharedService) {}
      hello() { return this.shared.greet(); }
    }

    @Controller('/dyn-imports')
    class FeatureController {
      constructor(private svc: FeatureService) {}
      @Get()
      handle() { return { msg: this.svc.hello() }; }
    }

    // register() returns a DynamicModule with imports
    class FeatureModule {
      static register(): DynamicModule {
        const moduleClass = { FeatureModule: class {} }.FeatureModule;
        defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
        MetadataRegistry.setModuleOptions(moduleClass, { exports: [FeatureService] });

        return {
          module: moduleClass as never,
          imports: [SharedModule],   // <-- imports inside DynamicModule return
          providers: [FeatureService],
          controllers: [FeatureController],
        };
      }
    }

    @Module({ imports: [FeatureModule.register()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/dyn-imports');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: 'hello from shared' });
  });

  it('should allow a dynamic module to import another dynamic module', async () => {
    @Injectable()
    class BaseService {
      value() { return 42; }
    }

    const makeBase = (): DynamicModule => {
      const moduleClass = { BaseModule: class {} }.BaseModule;
      defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
      MetadataRegistry.setModuleOptions(moduleClass, { exports: [BaseService] });
      return { module: moduleClass as never, providers: [BaseService] };
    };

    @Injectable()
    class TopService {
      constructor(private base: BaseService) {}
      get() { return this.base.value() * 2; }
    }

    @Controller('/nested-dyn')
    class TopController {
      constructor(private svc: TopService) {}
      @Get()
      handle() { return { v: this.svc.get() }; }
    }

    const makeTop = (): DynamicModule => {
      const moduleClass = { TopModule: class {} }.TopModule;
      defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
      MetadataRegistry.setModuleOptions(moduleClass, {});
      return {
        module: moduleClass as never,
        imports: [makeBase()],
        providers: [TopService],
        controllers: [TopController],
      };
    };

    @Module({ imports: [makeTop()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/nested-dyn');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 84 });
  });
});

// =============================================================================
// forwardRef() in module imports
// =============================================================================

describe('forwardRef() in module imports', () => {
  it('should resolve a simple forwardRef import', async () => {
    @Injectable()
    class HelperService {
      help() { return 'helped'; }
    }

    @Module({ providers: [HelperService], exports: [HelperService] })
    class HelperModule {}

    @Injectable()
    class AppService {
      constructor(private helper: HelperService) {}
      run() { return this.helper.help(); }
    }

    @Controller('/fwd-simple')
    class AppController {
      constructor(private svc: AppService) {}
      @Get()
      handle() { return { result: this.svc.run() }; }
    }

    @Module({
      imports: [forwardRef(() => HelperModule)],
      providers: [AppService],
      controllers: [AppController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/fwd-simple');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'helped' });
  });

  it('should handle mutually dependent modules via forwardRef', async () => {
    // ModuleA provides ServiceA, needs ServiceB from ModuleB
    // ModuleB provides ServiceB, needs ServiceA from ModuleA
    @Injectable()
    class ServiceA {
      name() { return 'A'; }
    }

    @Injectable()
    class ServiceB {
      name() { return 'B'; }
    }

    @Injectable()
    class CompositeService {
      constructor(private a: ServiceA, private b: ServiceB) {}
      both() { return `${this.a.name()}+${this.b.name()}`; }
    }

    @Controller('/circular-modules')
    class CompositeController {
      constructor(private svc: CompositeService) {}
      @Get()
      handle() { return { result: this.svc.both() }; }
    }

    // Use forwardRef to break the circular reference at the TypeScript level
    @Module({
      imports: [forwardRef(() => ModuleB)],
      providers: [ServiceA],
      exports: [ServiceA],
    })
    class ModuleA {}

    @Module({
      imports: [forwardRef(() => ModuleA)],
      providers: [ServiceB],
      exports: [ServiceB],
    })
    class ModuleB {}

    @Module({
      imports: [ModuleA, ModuleB],
      providers: [CompositeService],
      controllers: [CompositeController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/circular-modules');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'A+B' });
  });
});
