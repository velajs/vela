import { describe, expect, it } from 'vitest';
import { Inject, Injectable, Module, VelaFactory, type VelaEnv } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';
import { ScheduleModule } from '@velajs/vela/schedule';
import type { AdminRpcResponse, StudioOp, StudioOpReq, StudioOpRes } from '@velajs/studio-protocol';
import { AdminLogBuffer, StudioModule, defineStudioPlugin, type StudioPlugin } from '../src';
import { queuesPanel } from '../src/queue';
import { schedulePanel } from '../src/schedule';
import { livePanel } from '../src/live';

const TOKEN = 'test-master-token-value';
type App = Awaited<ReturnType<typeof VelaFactory.create>>;

async function rpc<Op extends StudioOp>(
  app: App,
  op: Op,
  args?: StudioOpReq<Op>,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await app.getHonoApp().request(`/_vela/admin/rpc/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
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
        StudioModule.forRoot({ token: TOKEN, plugins: [queuesPanel(), schedulePanel()] }),
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
    const probe: StudioPlugin = defineStudioPlugin({ name: 'probe', providers: [PanelProbe] });
    @Module({ imports: [StudioModule.forRoot({ token: TOKEN, plugins: [probe] })] })
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
    @Module({ imports: [StudioModule.forRoot({ token: TOKEN, plugins: [plugin] })] })
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

  it('keeps one Studio per application whatever its panels', async () => {
    @Module({ imports: [StudioModule.forRoot({ token: TOKEN, plugins: [queuesPanel()] })] })
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
