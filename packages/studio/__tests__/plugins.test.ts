import { describe, expect, it } from 'vitest';
import {
  APP_INTERCEPTOR,
  ENV,
  Inject,
  Injectable,
  Module,
  ModuleRef,
  Reflector,
  VelaFactory,
  defineProvider,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type ProviderDefinition,
  type VelaEnv,
} from '@velajs/vela';
import { APP_LOGGER, ApplicationLogger } from '@velajs/vela/logging';
import {
  Container,
  DiscoveryService,
  EntrypointRegistry,
  ROOT_MODULE,
} from '@velajs/vela/module-kit';
import { QueueModule } from '@velajs/vela/queue';
import { ScheduleModule } from '@velajs/vela/schedule';
import type { AdminRpcResponse, StudioOp, StudioOpReq, StudioOpRes } from '@velajs/studio-protocol';
import {
  AdminAuditLog,
  AdminLogBuffer,
  STUDIO_MODULE_OPTIONS,
  STUDIO_RESOLVED_CONFIG,
  StudioModule,
  defineStudioPlugin,
  resolveStudioConfig,
  type StudioPlugin,
} from '../src';
import { queuesPanel } from '../src/queue';
import { schedulePanel } from '../src/schedule';
import { livePanel } from '../src/live';
import { timeTravelPanel } from '../src/timetravel';
import { cloudflareTimeTravelPanel } from '../src/cloudflare';

const TOKEN = 'test-master-token-value';
type App = Awaited<ReturnType<typeof VelaFactory.create>>;

async function rpc<Op extends StudioOp>(
  app: App,
  op: Op,
  args?: StudioOpReq<Op>,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await app.getHonoApp().request(`/_vela/admin/rpc/${op}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args === undefined ? {} : { args }),
  });
  return (await res.json()) as AdminRpcResponse<StudioOpRes<Op>>;
}

function ok<T>(res: AdminRpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

describe('StudioModule plugins', () => {
  it('lights each panel from StudioModule.forRoot({ plugins }) alone', async () => {
    @Module({
      imports: [
        QueueModule.forRoot(),
        QueueModule.registerQueue({ name: 'email' }),
        ScheduleModule,
        StudioModule.forRoot({
          token: TOKEN,
          plugins: [queuesPanel(), schedulePanel()],
        }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.queue).toBe(true);
    expect(caps.features.schedule).toBe(true);
    expect(caps.features.flags).toBe(false);
    expect(ok(await rpc(app, 'queue.list'))).toEqual([{ name: 'email', kind: 'inline' }]);
    await app.close();
  });

  it('registers plugin providers in Studio scope, where they see Studio services', async () => {
    @Injectable()
    class PanelProbe {
      constructor(@Inject(AdminLogBuffer) readonly buffer: AdminLogBuffer) {}
    }
    const probe: StudioPlugin = defineStudioPlugin({
      name: 'probe',
      providers: [PanelProbe],
    });
    @Module({
      imports: [StudioModule.forRoot({ token: TOKEN, plugins: [probe] })],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect(app.get(PanelProbe).buffer).toBe(app.get(AdminLogBuffer));
    await app.close();
  });

  it('builds a panel source from each application ENV', async () => {
    const plugin = livePanel({
      source: (env: VelaEnv) => ({
        inspect: async () => ({
          subscriptions: [],
          rooms: [{ room: String(Reflect.get(env, 'ROOM')), count: 0, members: [] }],
        }),
      }),
    });
    @Module({
      imports: [StudioModule.forRoot({ token: TOKEN, plugins: [plugin] })],
    })
    class App {}
    const east = await VelaFactory.create(App, { env: { ROOM: 'east' } });
    const west = await VelaFactory.create(App, { env: { ROOM: 'west' } });
    expect(ok(await rpc(east, 'presence.rooms'))).toEqual([
      { room: 'east', count: 0, members: [] },
    ]);
    expect(ok(await rpc(west, 'presence.rooms'))).toEqual([
      { room: 'west', count: 0, members: [] },
    ]);
    await Promise.all([east.close(), west.close()]);
  });

  it('rejects a panel registered twice and malformed plugins', () => {
    expect(() => StudioModule.forRoot({ plugins: [queuesPanel(), queuesPanel()] })).toThrow(
      "Studio plugin 'queues' is registered twice",
    );
    expect(() => defineStudioPlugin({ name: '' })).toThrow('non-empty name');
  });

  it('rejects two panels that bind the same port, naming both', () => {
    expect(() =>
      StudioModule.forRoot({
        plugins: [timeTravelPanel(), cloudflareTimeTravelPanel({ binding: 'ROOM' })],
      }),
    ).toThrow(
      "Studio plugins 'time-travel' and 'cloudflare-time-travel' both provide " +
        'InjectionToken(TIME_TRAVEL_PORT)',
    );
    // Application-wide enhancers are collected, not replaced, so panels may share them.
    @Injectable()
    class Timing implements NestInterceptor {
      intercept(_context: ExecutionContext, next: CallHandler) {
        return next.handle();
      }
    }
    const enhancer = (name: string) =>
      defineStudioPlugin({
        name,
        providers: [defineProvider(APP_INTERCEPTOR, { useClass: Timing })],
      });
    expect(() =>
      StudioModule.forRoot({
        plugins: [enhancer('first'), enhancer('second')],
      }),
    ).not.toThrow();
  });

  it("rejects a panel that provides one of StudioModule's own tokens, naming it", async () => {
    const overrides = defineStudioPlugin({
      name: 'overrides',
      providers: [
        defineProvider(STUDIO_RESOLVED_CONFIG, {
          useFactory: () => resolveStudioConfig({}, { token: 'p'.repeat(32) }),
        }),
      ],
    });
    expect(() => StudioModule.forRoot({ token: TOKEN, plugins: [overrides] })).toThrow(
      "Studio plugin 'overrides' provides InjectionToken(STUDIO_RESOLVED_CONFIG), which " +
        'StudioModule provides itself',
    );
    // The async form checks the same tokens: its plugins are structural.
    expect(() =>
      StudioModule.forRootAsync({
        plugins: [overrides],
        useFactory: () => ({ token: TOKEN }),
      }),
    ).toThrow("Studio plugin 'overrides' provides InjectionToken(STUDIO_RESOLVED_CONFIG)");
    for (const provider of [
      AdminAuditLog,
      defineProvider(STUDIO_MODULE_OPTIONS, {
        useValue: { token: 'p'.repeat(32) },
      }),
    ]) {
      const plugin = defineStudioPlugin({
        name: 'shadow',
        providers: [provider],
      });
      expect(() => StudioModule.forRoot({ token: TOKEN, plugins: [plugin] })).toThrow(
        /Studio plugin 'shadow' provides .*, which StudioModule provides itself/,
      );
    }
  });

  it('rejects a panel that provides a framework token StudioModule injects, naming both', () => {
    // Inside Studio's scope such a provider would answer before the
    // application's own: Studio would read the panel's ENV (its admin token
    // among it), log through the panel's logger, or document another root.
    const cases: Array<[ProviderDefinition, string]> = [
      [
        defineProvider(ENV, {
          useValue: { VELA_STUDIO_TOKEN: 'p'.repeat(32) },
        }),
        'InjectionToken(ENV)',
      ],
      [
        defineProvider(APP_LOGGER, { useValue: new ApplicationLogger() }),
        'InjectionToken(vela.applicationLogger)',
      ],
      [defineProvider(ROOT_MODULE, { useValue: class Other {} }), 'InjectionToken(vela.RootModule)'],
      [defineProvider(Container, { useValue: new Container() }), 'Container'],
      [
        defineProvider(DiscoveryService, {
          useValue: new DiscoveryService(new Container()),
        }),
        'DiscoveryService',
      ],
      [
        defineProvider(EntrypointRegistry, {
          useValue: new EntrypointRegistry(),
        }),
        'EntrypointRegistry',
      ],
      [
        defineProvider(ModuleRef, {
          useValue: new ModuleRef(new Container(), 'Other'),
        }),
        'ModuleRef',
      ],
      [defineProvider(Reflector, { useValue: new Reflector() }), 'Reflector'],
    ];
    for (const [provider, label] of cases) {
      const plugin = defineStudioPlugin({
        name: 'shadow',
        providers: [provider],
      });
      expect(() => StudioModule.forRoot({ token: TOKEN, plugins: [plugin] })).toThrow(
        `Studio plugin 'shadow' provides ${label}, which StudioModule injects from the ` +
          'application; a panel cannot replace it.',
      );
    }
  });

  it("rejects the data browser's settings on StudioModule, pointing to crudPanel()", async () => {
    const moved =
      /StudioModule no longer takes managedModels.*crudPanel\(\{ managedModels, runAsIdentity \}\)/;
    // An async factory's result is not checked for extra keys by the compiler.
    @Module({
      imports: [
        StudioModule.forRootAsync({
          useFactory: () => ({
            token: TOKEN,
            managedModels: { include: ['public_only'] },
            runAsIdentity: { userId: 'limited' },
          }),
        }),
      ],
    })
    class AsyncApp {}
    await expect(VelaFactory.create(AsyncApp)).rejects.toThrow(moved);
    // Options built elsewhere, or passed from JavaScript, fail the same way,
    // whether or not Studio is open.
    for (const legacy of [
      { token: TOKEN, runAsIdentity: { userId: 'limited' } },
      { runAsIdentity: { userId: 'limited' } },
    ]) {
      @Module({ imports: [StudioModule.forRoot(legacy)] })
      class App {}
      await expect(VelaFactory.create(App)).rejects.toThrow(
        /StudioModule no longer takes runAsIdentity/,
      );
      expect(() => resolveStudioConfig({}, legacy)).toThrow(/no longer takes runAsIdentity/);
    }
  });

  it('keeps one Studio per application whatever its panels', async () => {
    @Module({
      imports: [StudioModule.forRoot({ token: TOKEN, plugins: [queuesPanel()] })],
    })
    class Feature {}
    @Module({
      imports: [Feature, StudioModule.forRoot({ token: TOKEN, plugins: [schedulePanel()] })],
    })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'throw' })).rejects.toThrow(
      /StudioModule#application was imported again with different options/,
    );
  });

  it('keeps plugins structural: forRootAsync takes them next to its factory', async () => {
    @Module({
      imports: [
        QueueModule.forRoot(),
        StudioModule.forRootAsync({
          plugins: [queuesPanel()],
          useFactory: () => ({ token: TOKEN }),
        }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect(ok(await rpc(app, 'studio.capabilities')).features.queue).toBe(true);
    await app.close();
  });
});
