import { describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Controller,
  defineModule,
  defineProvider,
  Get,
  Injectable,
  InjectionToken,
  Module,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type GuardPhase,
} from '../index.js';
import { SkipGuardPhases } from '../module-kit.js';

function phasedGuard(name: string, phase?: GuardPhase, skippable = false, allow = true) {
  @Injectable()
  class PhasedGuard implements CanActivate {
    static readonly phase = phase;
    static readonly skippable = skippable;
    canActivate(): boolean {
      trace.push(name);
      return allow;
    }
  }
  Object.defineProperty(PhasedGuard, 'name', { value: `${name}Guard` });
  return PhasedGuard;
}

let trace: string[] = [];

// Each integration installs its guard through the defineModule `global:` slot,
// and declares it skippable on the routes of integrations that enforce the phase.
function guardModule(name: string, guard: ReturnType<typeof phasedGuard>) {
  const { ConfigurableModuleClass } = defineModule<{ guard?: 'global' | 'none' }, 'guard'>({
    name,
    structural: ['guard'],
    defaults: { guard: 'global' },
    setup: ({ options }) => ({
      global: options.guard === 'none' ? {} : { guards: [guard] },
    }),
  });
  return ConfigurableModuleClass;
}

const Throttling = guardModule('Throttling', phasedGuard('feature', 'feature', true));
const Authorization = guardModule('Authorization', phasedGuard('authorize', 'authorize', true));
const Tenancy = guardModule('Tenancy', phasedGuard('tenant', 'tenant', true));
const Authentication = guardModule(
  'Authentication',
  phasedGuard('authenticate', 'authenticate', true),
);

@Controller('/phased')
class PhasedController {
  @Get()
  get() {
    return trace;
  }
}

describe('deterministic global guard phases', () => {
  it('runs authenticate, tenant, authorize, then feature guards regardless of import order', async () => {
    const Unphased = phasedGuard('unphased');
    @Module({
      imports: [
        Throttling.forRoot({}),
        Authorization.forRoot({}),
        Tenancy.forRoot({}),
        Authentication.forRoot({}),
      ],
      controllers: [PhasedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new Unphased());
    const instance = {
      phase: 'authenticate',
      canActivate: () => {
        trace.push('instance');
        return true;
      },
    };
    app.useGlobalGuards(instance);
    trace = [];
    expect(await (await app.getHonoApp().request('/phased')).json()).toEqual([
      'authenticate',
      'instance',
      'tenant',
      'authorize',
      'feature',
      'unphased',
    ]);
  });

  it("does not install a module's guard when it opts out with guard: 'none'", async () => {
    @Module({
      imports: [Authentication.forRoot({ guard: 'none' }), Tenancy.forRoot({})],
      controllers: [PhasedController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    trace = [];
    expect(await (await app.getHonoApp().request('/phased')).json()).toEqual(['tenant']);
  });

  it('ranks a factory-provided global guard by the phase its instance declares', async () => {
    const Authorize = phasedGuard('authorize', 'authorize');
    const FactoryAuthenticate = phasedGuard('factory-authenticate', 'authenticate');
    const Aliased = phasedGuard('aliased-tenant', 'tenant');
    const ALIASED = new InjectionToken<CanActivate>('aliased tenant guard');
    @Module({
      controllers: [PhasedController],
      providers: [
        Authorize,
        defineProvider(APP_GUARD, { useExisting: Authorize }),
        // Neither registration names a class, so the phase is only known once built.
        defineProvider(APP_GUARD, { useExisting: ALIASED }),
        defineProvider(ALIASED, { useFactory: () => new Aliased() }),
        defineProvider(APP_GUARD, { useFactory: () => new FactoryAuthenticate() }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    trace = [];
    expect(await (await app.getHonoApp().request('/phased')).json()).toEqual([
      'factory-authenticate',
      'aliased-tenant',
      'authorize',
    ]);
  });

  it('skips tenant and authorize global guards on routes an integration marks', async () => {
    const RouteGuard = phasedGuard('route', 'authorize');
    @Controller('/integration')
    @SkipGuardPhases(['tenant', 'authorize'])
    @UseGuards(RouteGuard)
    class IntegrationController {
      @Get()
      get() {
        return trace;
      }
    }

    @Module({
      imports: [
        Throttling.forRoot({}),
        Authorization.forRoot({}),
        Tenancy.forRoot({}),
        Authentication.forRoot({}),
      ],
      controllers: [PhasedController, IntegrationController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    trace = [];
    // Authentication and feature guards still run, and so do the route's own guards.
    expect(await (await app.getHonoApp().request('/integration')).json()).toEqual([
      'authenticate',
      'feature',
      'route',
    ]);
    trace = [];
    expect(await (await app.getHonoApp().request('/phased')).json()).toEqual([
      'authenticate',
      'tenant',
      'authorize',
      'feature',
    ]);
  });

  it("still runs the application's own tenant and authorize guards on routes an integration marks", async () => {
    const AppTenant = phasedGuard('app-tenant', 'tenant');
    const AppAuthorize = phasedGuard('app-authorize', 'authorize', false, false);
    @Controller('/integration')
    @SkipGuardPhases(['tenant', 'authorize'])
    class IntegrationController {
      @Get()
      get() {
        return trace;
      }
    }

    @Module({
      imports: [Authorization.forRoot({}), Tenancy.forRoot({})],
      controllers: [IntegrationController],
      providers: [AppAuthorize, defineProvider(APP_GUARD, { useExisting: AppAuthorize })],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new AppTenant());
    trace = [];
    // Only the guards the integrations installed are skipped; the app's deny.
    expect((await app.getHonoApp().request('/integration')).status).toBe(403);
    expect(trace).toEqual(['app-tenant', 'app-authorize']);
  });

  it('skips an application guard built on an integration guard unless it opts out', async () => {
    const IntegrationTenant = phasedGuard('integration-tenant', 'tenant', true);
    // Extending an integration's guard inherits its `skippable`.
    class ExtendedTenant extends IntegrationTenant {
      override canActivate(): boolean {
        trace.push('extended-tenant');
        return true;
      }
    }
    class StrictTenant extends IntegrationTenant {
      static override readonly skippable = false;
      override canActivate(): boolean {
        trace.push('strict-tenant');
        return true;
      }
    }
    @Controller('/integration')
    @SkipGuardPhases(['tenant'])
    class IntegrationController {
      @Get()
      get() {
        return trace;
      }
    }

    @Module({ controllers: [IntegrationController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.useGlobalGuards(new ExtendedTenant(), new StrictTenant(), new IntegrationTenant());
    trace = [];
    expect(await (await app.getHonoApp().request('/integration')).json()).toEqual([
      'strict-tenant',
    ]);
  });

  it('lets integration routes skip only the tenant and authorize phases', () => {
    // @ts-expect-error: authentication and feature guards cover every route.
    expect(() => SkipGuardPhases(['authenticate'])).toThrow(
      "SkipGuardPhases accepts 'tenant' and 'authorize', not 'authenticate'",
    );
  });

  it('rejects an unknown phase', async () => {
    @Module({ controllers: [PhasedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const broken = { phase: 'nonsense', canActivate: () => true };
    expect(() => app.useGlobalGuards(broken)).toThrow("unknown guard phase 'nonsense'");
  });
});
