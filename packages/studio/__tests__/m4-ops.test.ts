import { describe, expect, it } from 'vitest';
import { Controller, Get, Injectable, Module, ScheduleModule, VelaFactory } from '@velajs/vela';
import type { ProviderDefinition, Type } from '@velajs/vela';
import { AdminRpc, AdminLogBuffer, StudioModule } from '../src';
import type { StudioModuleOptions } from '../src';
import type {
  AdminRpcResponse,
  ModuleNode,
  RouteRow,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
} from '@velajs/studio-protocol';

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

// ---- fixture: two controllers (one prefixed, one with a named route) --------
@Controller('/widgets')
class WidgetsController {
  @Get('/')
  list() {
    return [];
  }
}

@Controller()
class StatusController {
  @Get('/status', { name: 'status' })
  status() {
    return 'ok';
  }
}

@Module({ controllers: [WidgetsController, StatusController] })
class ApiModule {}

@Controller('/reports')
class ReportsController {
  @Get()
  list() {
    return [];
  }
}

@Module({ controllers: [ReportsController] })
class ReportsModule {}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

/** Build a real app: the fixture ApiModule + StudioModule + any extra providers. */
async function makeApp(
  studio: Partial<StudioModuleOptions> = {},
  extra: Array<Type | ProviderDefinition> = [],
  imports: Type[] = [],
): Promise<App> {
  @Module({
    imports: [ApiModule, ...imports, StudioModule.forRoot({ token: TOKEN, ...studio })],
    providers: extra,
  })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

function authed(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
  };
}

/** Typed dispatch helper — dogfoods the exported op signatures end-to-end. */
async function rpc<Op extends StudioOp>(
  app: App,
  op: Op,
  args?: StudioOpReq<Op>,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await app
    .getHonoApp()
    .request(`${BASE}/rpc/${op}`, authed(args !== undefined ? { args } : {}));
  return (await res.json()) as AdminRpcResponse<StudioOpRes<Op>>;
}

describe('app.routes', () => {
  it('returns both controllers with an honest degraded source', async () => {
    const app = await makeApp();
    const r = await rpc(app, 'app.routes');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const rows: RouteRow[] = r.data;

    // The named-route controller mounts /status; the prefixed one mounts under
    // /widgets. Both are present.
    expect(rows.some((row) => row.method === 'GET' && row.path === '/status')).toBe(true);
    expect(rows.some((row) => row.method === 'GET' && row.path.startsWith('/widgets'))).toBe(true);

    // Honest degradation: RouteManager.describeRoutes() is unreachable via the
    // public barrel, so NO row can claim a Controller#handler — every row is
    // '(mounted)' / 'mounted'.
    expect(rows.every((row) => row.handler === '(mounted)' && row.source === 'mounted')).toBe(true);
    // The studio surface is part of the real routing table too.
    expect(rows.some((row) => row.path === `${BASE}/health`)).toBe(true);
  });
});

describe('app.modules', () => {
  it('lists the fixture modules with import edges and lazy flags', async () => {
    const app = await makeApp({}, [], [ScheduleModule]);
    const r = await rpc(app, 'app.modules');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const modules: ModuleNode[] = r.data;

    // Structural: every node carries the ModuleDescription mirror shape.
    for (const m of modules) {
      expect(typeof m.moduleId).toBe('string');
      expect(Array.isArray(m.imports)).toBe(true);
      expect(typeof m.isGlobal).toBe('boolean');
      expect(typeof m.lazy).toBe('boolean');
    }

    const appNode = modules.find((m) => m.moduleId.startsWith('AppModule'));
    const api = modules.find((m) => m.moduleId.startsWith('ApiModule'));
    const schedule = modules.find((m) => m.moduleId.startsWith('ScheduleModule'));
    expect(api).toBeDefined();
    expect(schedule).toBeDefined();
    // The root app module imports the fixture module (edge preserved).
    expect(appNode?.imports).toContain(api!.moduleId);
    // ScheduleModule is a lazy module — the lazy flag surfaces honestly.
    expect(schedule?.lazy).toBe(true);
  });
});

describe('app.entrypoints', () => {
  it('returns [] when the app registered no entrypoint-kind providers', async () => {
    // NOTE: @Cron/@Interval are NOT entrypoint kinds in 1.20 — ScheduleRegistry
    // discovers them via CRON_METADATA, not the EntrypointRegistry. Only queue
    // (`@Processor`) and websocket (`@WebSocketGateway`) register entrypoint
    // kinds, and the fixture wires neither, so the table is empty.
    const app = await makeApp({}, [], [ScheduleModule]);
    const r = await rpc(app, 'app.entrypoints');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data).toEqual([]);
  });
});

describe('app.openapi', () => {
  async function documentedPaths(app: App): Promise<string[]> {
    const r = await rpc(app, 'app.openapi');
    if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
    const doc = r.data as { paths?: Record<string, unknown> };
    return Object.keys(doc.paths ?? {});
  }

  it('documents the application root (ROOT_MODULE) when no rootModule is given', async () => {
    const app = await makeApp({}, [], [ReportsModule]);

    const paths = await documentedPaths(app);

    expect(paths).toContain('/status');
    expect(paths).toContain('/reports');
  });

  it('documents only an explicit rootModule', async () => {
    const app = await makeApp({ rootModule: ApiModule }, [], [ReportsModule]);

    const paths = await documentedPaths(app);

    expect(paths).toContain('/status');
    expect(paths).not.toContain('/reports');
  });

  it('documents a DynamicModule application root', async () => {
    @Module({})
    class Shell {}
    const app = await VelaFactory.create({
      module: Shell,
      imports: [ApiModule, StudioModule.forRoot({ token: TOKEN })],
      controllers: [ReportsController],
    });

    const paths = await documentedPaths(app);

    expect(paths).toContain('/status');
    expect(paths).toContain('/reports');
  });

  it('returns an OpenAPI 3.x document with the fixture paths when rootModule is set', async () => {
    const app = await makeApp({ rootModule: ApiModule });
    const r = await rpc(app, 'app.openapi');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const doc = r.data as { openapi?: string; paths?: Record<string, unknown> };
    expect(typeof doc.openapi).toBe('string');
    expect(doc.openapi?.startsWith('3.')).toBe(true);
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain('/status');
    expect(paths.some((p) => p.startsWith('/widgets'))).toBe(true);
  });

  it('carries the app global prefix in the documented paths', async () => {
    // The captured global prefix must flow into createOpenApiDocument so the
    // documented paths match the real mounted routes (M4 review carry-over).
    @Module({
      imports: [
        ApiModule,
        // `absolute` keeps the admin surface at /_vela/admin (reachable by the
        // rpc helper) while the app's own routes take the global prefix — which
        // the captured holder still reports, so the doc paths carry it.
        StudioModule.forRoot({ token: TOKEN, rootModule: ApiModule, absolute: true }),
      ],
    })
    class PrefixedAppModule {}
    const app = await VelaFactory.create(PrefixedAppModule, { globalPrefix: '/api/v1' });

    const r = await rpc(app, 'app.openapi');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const doc = r.data as { paths?: Record<string, unknown> };
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain('/api/v1/status');
    expect(paths.some((p) => p.startsWith('/api/v1/widgets'))).toBe(true);
    // ...and nothing is documented at the un-prefixed path.
    expect(paths).not.toContain('/status');
  });
});

describe('api.authorizeTryIt', () => {
  it('authorizes HTTP execution by the local host', async () => {
    // opsEditable open so the write gate lets the proxy run.
    const app = await makeApp({ editable: { ops: true } });
    const r = await rpc(app, 'api.authorizeTryIt', { method: 'GET', path: '/status' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data).toEqual({ authorized: true });
  });

  it('is gated: opsEditable off ⇒ 403 STUDIO_OP_FORBIDDEN', async () => {
    // ops disabled by default → the dispatch registry's write gate closes first.
    const app = await makeApp();
    const r = await rpc(app, 'api.authorizeTryIt', { method: 'GET', path: '/status' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error');
    expect(r.status).toBe(403);
    expect(r.error.code).toBe('STUDIO_OP_FORBIDDEN');
  });

  it('refuses to proxy the reserved admin surface (recursive-admin guard)', async () => {
    // opsEditable is OPEN here, so the gate passes — a 403 can ONLY be the guard.
    const app = await makeApp({ editable: { ops: true } });
    const r = await rpc(app, 'api.authorizeTryIt', {
      method: 'POST',
      path: `${BASE}/rpc/data.clearTable`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error');
    expect(r.status).toBe(403);
    expect(r.error.code).toBe('STUDIO_OP_FORBIDDEN');
  });

  it('protects a custom admin mount including encoded paths and rejects unresolved or external targets', async () => {
    const app = await makeApp({ path: '/custom/admin', editable: { ops: true } });
    for (const path of [
      '/custom/admin/health',
      '/custom/%61dmin/health',
      '/x/../custom/admin/health',
      'https://example.com',
      '/users/{id}',
    ]) {
      const response = await app
        .getHonoApp()
        .request('/custom/admin/rpc/api.authorizeTryIt', authed({ args: { method: 'GET', path } }));
      expect(response.status).toBe(403);
    }
  });
});

describe('logs.tail', () => {
  it('honors the level filter and the limit', async () => {
    const app = await makeApp();
    const buffer = app.getContainer().resolve(AdminLogBuffer);
    buffer.record({ ts: 1, level: 'info', msg: 'a' });
    buffer.record({ ts: 2, level: 'error', msg: 'b' });
    buffer.record({ ts: 3, level: 'info', msg: 'c' });
    buffer.record({ ts: 4, level: 'error', msg: 'd' });

    const errors = await rpc(app, 'logs.tail', { level: 'error' });
    expect(errors.ok).toBe(true);
    if (!errors.ok) throw new Error('expected ok');
    expect(errors.data.map((e) => e.msg)).toEqual(['d', 'b']);

    const limited = await rpc(app, 'logs.tail', { limit: 1 });
    expect(limited.ok).toBe(true);
    if (!limited.ok) throw new Error('expected ok');
    expect(limited.data.map((e) => e.msg)).toEqual(['d']);
  });
});

describe('audit.tail', () => {
  it('surfaces the write-op audit row recorded by a prior dispatch', async () => {
    @Injectable()
    class DataOps {
      @AdminRpc({ op: 'data.writeRow' })
      writeRow() {
        return { id: '1' };
      }
    }
    // data editing enabled so the write op is not gated.
    const app = await makeApp({ editable: { data: true } }, [DataOps]);

    const write = await rpc(app, 'data.writeRow', { model: 'Widget', patch: {} });
    expect(write.ok).toBe(true);

    const r = await rpc(app, 'audit.tail', {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const row = r.data.find((e) => e.op === 'data.writeRow');
    expect(row).toBeDefined();
    expect(row?.mode).toBe('write');
    expect(row?.status).toBe(200);
    expect(row?.subject).toBe('master');

    // The limit is honored (most-recent first).
    const limited = await rpc(app, 'audit.tail', { limit: 1 });
    expect(limited.ok).toBe(true);
    if (!limited.ok) throw new Error('expected ok');
    expect(limited.data.length).toBe(1);
  });
});

describe('studio.capabilities', () => {
  it('detects always-on features and reflects config write gates', async () => {
    const app = await makeApp({ editable: { data: true, ops: true } });
    const r = await rpc(app, 'studio.capabilities');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const { features, writes, timeTravel } = r.data;

    // Always wired by Studio itself.
    expect(features.app).toBe(true);
    expect(features.logs).toBe(true);
    expect(features.audit).toBe(true);
    // No rootModule here, so the application root (ROOT_MODULE) is documented.
    expect(features.openapi).toBe(true);
    // Nothing optional wired → every negotiated feature is false.
    for (const key of [
      'data',
      'timeTravel',
      'transfer',
      'auth',
      'authOrganizations',
      'queue',
      'schedule',
      'flags',
      'live',
      'presence',
    ] as const) {
      expect(features[key]).toBe(false);
    }

    // Write gates mirror the resolved editable config 1:1.
    expect(writes.dataEditable).toBe(true);
    expect(writes.opsEditable).toBe(true);
    expect(writes.schemaEditable).toBe(false);
    expect(writes.timeTravelRestore).toBe(false);
    expect(timeTravel).toBeNull();
  });

  it('flips openapi on when a rootModule is configured', async () => {
    const app = await makeApp({ rootModule: ApiModule });
    const r = await rpc(app, 'studio.capabilities');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.features.openapi).toBe(true);
  });

  it('does not advertise schedule without registered Studio handlers', async () => {
    const app = await makeApp({}, [], [ScheduleModule]);
    const r = await rpc(app, 'studio.capabilities');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    // Real detection: the (lazy) ScheduleModule registers ScheduleRegistry, a
    // public barrel token the probe table checks.
    expect(r.data.features.schedule).toBe(false);
    // ...and an unrelated optional feature stays false.
    expect(r.data.features.queue).toBe(false);
  });
});
