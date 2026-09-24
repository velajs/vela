import { describe, expect, it } from 'vitest';
import {
  Controller,
  defineModule,
  Get,
  Injectable,
  Module,
  VelaFactory,
  type CanActivate,
  type GuardPhase,
} from '../index.js';

function phasedGuard(name: string, phase?: GuardPhase) {
  @Injectable()
  class PhasedGuard implements CanActivate {
    static readonly phase = phase;
    canActivate(): boolean {
      trace.push(name);
      return true;
    }
  }
  Object.defineProperty(PhasedGuard, 'name', { value: `${name}Guard` });
  return PhasedGuard;
}

let trace: string[] = [];

// Each integration installs its guard through the defineModule `global:` slot.
function guardModule(name: string, guard: ReturnType<typeof phasedGuard>) {
  const { ConfigurableModuleClass } = defineModule<{ guard?: 'global' | 'none' }>({
    name,
    setup: ({ options }) => ({
      global: options.guard === 'none' ? {} : { guards: [guard] },
    }),
  });
  return ConfigurableModuleClass;
}

const Throttling = guardModule('Throttling', phasedGuard('feature', 'feature'));
const Authorization = guardModule('Authorization', phasedGuard('authorize', 'authorize'));
const Tenancy = guardModule('Tenancy', phasedGuard('tenant', 'tenant'));
const Authentication = guardModule('Authentication', phasedGuard('authenticate', 'authenticate'));

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

  it('rejects an unknown phase', async () => {
    @Module({ controllers: [PhasedController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const broken = { phase: 'nonsense', canActivate: () => true };
    expect(() => app.useGlobalGuards(broken)).toThrow("unknown guard phase 'nonsense'");
  });
});
