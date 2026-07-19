import { describe, expect, it } from 'vitest';
import {
  Controller,
  Cron,
  Get,
  Injectable,
  Module,
  ScheduleModule,
  VelaFactory,
} from '@velajs/vela';
import type { ModuleImport, ProviderOptions, Type } from '@velajs/vela';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import { FeatureFlagsModule } from '@velajs/feature-flags';
import {
  STUDIO_AUTH_SOURCE,
  STUDIO_MODEL_SOURCE,
  StudioModule,
  studioRuntimeAdapter,
} from '../src';
import type {
  StudioAuthCapabilities,
  StudioAuthSource,
  StudioModelSource,
  StudioModuleOptions,
  StudioWriteContext,
  StudioWriteRowOutcome,
} from '../src';
import { StudioAuthModule } from '../src/auth';
import { StudioFlagsModule } from '../src/flags';
import { StudioQueueModule } from '../src/queue';
import { StudioScheduleModule } from '../src/schedule';
import { StudioLiveModule } from '../src/live';
import type {
  AdminRpcResponse,
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
  ClearTableRequest,
  DeleteRowsRequest,
  ListRowsRequest,
  StudioConfirmChallenge,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
  StudioRowPage,
  WriteRowRequest,
} from '@velajs/studio-protocol';

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

type App = Awaited<ReturnType<typeof VelaFactory.create>>;
type Row = Record<string, unknown>;

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

function ok<T>(res: AdminRpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

function challenge<T>(res: AdminRpcResponse<T>): StudioConfirmChallenge {
  if (res.ok) throw new Error(`expected a 428 challenge, got ${JSON.stringify(res)}`);
  expect(res.status).toBe(428);
  return res.error.details as StudioConfirmChallenge;
}

// ===========================================================================
// A minimal write-capable model source (transfer round-trip fixture).
// ===========================================================================

class FakeModelSource implements StudioModelSource {
  readonly rows = new Map<string, Row>();
  constructor(
    private readonly model: string,
    private readonly table: string,
    seed: Row[] = [],
  ) {
    for (const r of seed) this.rows.set(String(r.id), r);
  }

  private assert(model: string): void {
    if (model !== this.model) throw new Error(`unknown model ${model}`);
  }

  listModels(): StudioModelInfo[] {
    return [{ name: this.model, table: this.table, label: this.model, capabilities: [] }];
  }

  describe(model: string): StudioModelDescriptor {
    this.assert(model);
    return {
      name: this.model,
      table: this.table,
      primaryKeys: ['id'],
      columns: [
        { name: 'id', type: 'string', pk: true, nullable: false, unique: true, managed: false },
        { name: 'name', type: 'string', pk: false, nullable: false, unique: false, managed: false },
      ],
      relations: [],
      flags: { softDelete: false, multiTenant: false, versioning: false, audit: false },
      supports: { facets: false, search: false, cascade: false },
    };
  }

  async list(model: string, request: ListRowsRequest): Promise<StudioRowPage> {
    this.assert(model);
    const all = [...this.rows.values()];
    const page = request.page ?? 1;
    const perPage = request.perPage ?? 20;
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return {
      rows: slice.map((r) => ({ ...r })),
      info: {
        page,
        per_page: perPage,
        total_count: all.length,
        has_next_page: page * perPage < all.length,
        has_prev_page: page > 1,
      },
    };
  }

  async readOne(model: string, id: string): Promise<Row | null> {
    this.assert(model);
    return this.rows.get(id) ?? null;
  }

  async writeRow(
    model: string,
    request: WriteRowRequest,
    _ctx: StudioWriteContext,
  ): Promise<StudioWriteRowOutcome> {
    this.assert(model);
    const id = request.id ?? String(request.patch.id);
    const before = this.rows.get(id) ?? null;
    const after = { ...(before ?? {}), ...request.patch };
    this.rows.set(id, after);
    return { after, before };
  }

  async deleteRows(
    model: string,
    request: DeleteRowsRequest,
    _ctx: StudioWriteContext,
  ): Promise<{ deleted: number; before: Row[]; beforeCapped: boolean }> {
    this.assert(model);
    let deleted = 0;
    for (const id of request.ids) if (this.rows.delete(id)) deleted += 1;
    return { deleted, before: [], beforeCapped: false };
  }

  async clearTable(
    model: string,
    _request: ClearTableRequest,
    _ctx: StudioWriteContext,
  ): Promise<{ deleted: number }> {
    this.assert(model);
    const deleted = this.rows.size;
    this.rows.clear();
    return { deleted };
  }
}

function sourceModule(source: StudioModelSource): Type {
  @Module({
    providers: [{ provide: STUDIO_MODEL_SOURCE, useValue: source }],
    exports: [STUDIO_MODEL_SOURCE],
  })
  class SourceModule {}
  return SourceModule;
}

async function makeApp(
  studio: Partial<StudioModuleOptions> = {},
  imports: ModuleImport[] = [],
  extra: Array<Type | ProviderOptions> = [],
): Promise<App> {
  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, ...studio }), ...imports],
    providers: extra,
  })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

// ===========================================================================
// Route-attribution adapter
// ===========================================================================

@Controller('/widgets')
class WidgetsController {
  @Get('/')
  list() {
    return [];
  }
}

describe('studioRuntimeAdapter — route attribution', () => {
  async function routeApp(withAdapter: boolean): Promise<App> {
    @Module({
      imports: [StudioModule.forRoot({ token: TOKEN })],
      controllers: [WidgetsController],
    })
    class AppModule {}
    return VelaFactory.create(
      AppModule,
      withAdapter ? { adapters: [studioRuntimeAdapter] } : undefined,
    );
  }

  it('reports real Controller#handler / source:controller when the adapter is wired', async () => {
    const app = await routeApp(true);
    const rows = ok(await rpc(app, 'app.routes'));
    const widget = rows.find((r) => r.method === 'GET' && r.path.startsWith('/widgets'));
    expect(widget).toBeDefined();
    expect(widget?.handler).toBe('WidgetsController#list');
    expect(widget?.source).toBe('controller');
    // The admin surface is a contributor mount → still degraded to '(mounted)'.
    const health = rows.find((r) => r.path === `${BASE}/health`);
    expect(health?.source).toBe('mounted');
  });

  it('degrades every row to (mounted) when the adapter is NOT wired', async () => {
    const app = await routeApp(false);
    const rows = ok(await rpc(app, 'app.routes'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.handler === '(mounted)' && r.source === 'mounted')).toBe(true);
  });
});

// ===========================================================================
// Transfer — export / import round-trip + the /export route
// ===========================================================================

describe('transfer ops + /export route', () => {
  function transferApp(
    source: StudioModelSource,
    editable: Partial<StudioModuleOptions['editable']> = {},
  ) {
    return makeApp({ editable: { transfer: true, ...editable } }, [sourceModule(source)]);
  }

  async function getExport(app: App, url: string): Promise<Response> {
    return app.getHonoApp().request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '10.0.0.1' },
    });
  }

  it('transfer feature lights only when a model source is bound', async () => {
    const bare = await makeApp();
    expect(ok(await rpc(bare, 'studio.capabilities')).features.transfer).toBe(false);
    const withSource = await transferApp(
      new FakeModelSource('widget', 'widgets', [{ id: 'w1', name: 'a' }]),
    );
    expect(ok(await rpc(withSource, 'studio.capabilities')).features.transfer).toBe(true);
  });

  it('export returns a /export URL that streams the model as NDJSON', async () => {
    const source = new FakeModelSource('widget', 'widgets', [
      { id: 'w1', name: 'alpha' },
      { id: 'w2', name: 'beta' },
    ]);
    const app = await transferApp(source);
    const { exportUrl } = ok(await rpc(app, 'transfer.export', { model: 'widget' }));
    expect(exportUrl).toBe(`${BASE}/export?model=widget`);

    const res = await getExport(app, exportUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Row);
    expect(lines).toEqual([
      { id: 'w1', name: 'alpha' },
      { id: 'w2', name: 'beta' },
    ]);
  });

  it('round-trips export → import into a fresh source, rides the 428, reports per-line errors', async () => {
    const from = new FakeModelSource('widget', 'widgets', [
      { id: 'w1', name: 'alpha' },
      { id: 'w2', name: 'beta' },
    ]);
    const fromApp = await transferApp(from);
    const ndjsonText = await (await getExport(fromApp, `${BASE}/export?model=widget`)).text();
    // Add a malformed line the importer must report (not abort on).
    const withBadLine = `${ndjsonText}not-json\n`;

    const to = new FakeModelSource('widget', 'widgets');
    const toApp = await transferApp(to);

    // Destructive: first attempt (no token) → 428 challenge with a human summary.
    const first = await rpc(toApp, 'transfer.import', {
      model: 'widget',
      ndjson: withBadLine,
      confirmToken: '',
    });
    const { confirmToken, summary } = challenge(first);
    expect(summary.toLowerCase()).toContain('import');

    const result = ok(
      await rpc(toApp, 'transfer.import', { model: 'widget', ndjson: withBadLine, confirmToken }),
    );
    expect(result.imported).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.line).toBe(3);
    expect([...to.rows.keys()].toSorted()).toEqual(['w1', 'w2']);
  });

  it('import gates on the transferImport write gate (403 when closed)', async () => {
    const app = await makeApp({ editable: { transfer: false } }, [
      sourceModule(new FakeModelSource('widget', 'widgets')),
    ]);
    const res = await rpc(app, 'transfer.import', {
      model: 'widget',
      ndjson: '{"id":"x"}\n',
      confirmToken: '',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(403);
  });

  it('export degrades to FEATURE_UNCONFIGURED with no source bound', async () => {
    const app = await makeApp({ editable: { transfer: true } });
    const res = await rpc(app, 'transfer.export', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
  });
});

// ===========================================================================
// Auth — over a fake StudioAuthSource port (the ops/gating/mapping seam)
// ===========================================================================

class FakeAuthSource implements StudioAuthSource {
  revoked: string[] = [];
  constructor(private readonly caps: StudioAuthCapabilities) {}

  capabilities(): StudioAuthCapabilities {
    return this.caps;
  }

  async listUsers(query: { q?: string; cursor?: string }): Promise<{
    rows: AuthUserRow[];
    nextCursor?: string;
  }> {
    const rows: AuthUserRow[] = [
      { id: 'u1', email: 'ann@x.io', emailVerified: true, createdAt: 1, role: 'admin' },
      { id: 'u2', email: 'bob@x.io', emailVerified: false, createdAt: 2 },
    ].filter((u) => query.q === undefined || u.email.includes(query.q));
    return { rows };
  }

  async userDetail(id: string): Promise<AuthUserDetail> {
    const { rows } = await this.listUsers({});
    const user = rows.find((r) => r.id === id)!;
    return { user, sessions: await this.listSessions(id), organizations: [] };
  }

  async listSessions(userId?: string): Promise<AuthSessionRow[]> {
    return [{ id: 's1', userId: userId ?? 'u1', createdAt: 1, expiresAt: 99 }];
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.revoked.push(sessionId);
  }

  async listOrganizations(): Promise<AuthOrgRow[]> {
    return [{ id: 'o1', name: 'Acme', createdAt: 1, slug: 'acme' }];
  }
}

function authModule(source: StudioAuthSource): Type {
  @Module({
    providers: [{ provide: STUDIO_AUTH_SOURCE, useValue: source }],
    exports: [STUDIO_AUTH_SOURCE],
  })
  class FakeAuthModule {}
  return FakeAuthModule;
}

describe('auth ops (over the STUDIO_AUTH_SOURCE port)', () => {
  it('auth feature is false + ops FEATURE_UNCONFIGURED when no source is bound', async () => {
    const app = await makeApp({ editable: { ops: true } });
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.auth).toBe(false);
    expect(caps.features.authOrganizations).toBe(false);
    const res = await rpc(app, 'auth.users', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
  });

  it('admin caps light auth (independently of authOrganizations); read ops map rows', async () => {
    const app = await makeApp({ editable: { ops: true } }, [
      authModule(new FakeAuthSource({ admin: true, organizations: false })),
    ]);
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.auth).toBe(true);
    expect(caps.features.authOrganizations).toBe(false);

    const users = ok(await rpc(app, 'auth.users', {}));
    expect(users.rows.map((u) => u.id)).toEqual(['u1', 'u2']);
    const detail = ok(await rpc(app, 'auth.userDetail', { id: 'u1' }));
    expect(detail.user.email).toBe('ann@x.io');
    expect(detail.sessions[0]?.id).toBe('s1');

    // organization plugin absent → the org op degrades, feature stays dark.
    const orgs = await rpc(app, 'auth.organizations', {});
    expect(orgs.ok).toBe(false);
    if (orgs.ok) throw new Error('expected error');
    expect(orgs.error.code).toBe('FEATURE_UNCONFIGURED');
  });

  it('authOrganizations lights independently when the org plugin is present', async () => {
    const app = await makeApp({}, [
      authModule(new FakeAuthSource({ admin: false, organizations: true })),
    ]);
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.auth).toBe(false);
    expect(caps.features.authOrganizations).toBe(true);
    const orgs = ok(await rpc(app, 'auth.organizations', {}));
    expect(orgs.map((o) => o.id)).toEqual(['o1']);
  });

  it('auth.revokeSession gates on opsEditable (403 closed → ok open)', async () => {
    const source = new FakeAuthSource({ admin: true, organizations: false });
    const closed = await makeApp({ editable: { ops: false } }, [authModule(source)]);
    const denied = await rpc(closed, 'auth.revokeSession', { sessionId: 's9' });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('expected error');
    expect(denied.status).toBe(403);

    const open = await makeApp({ editable: { ops: true } }, [authModule(source)]);
    expect(ok(await rpc(open, 'auth.revokeSession', { sessionId: 's9' }))).toEqual({ ok: true });
    expect(source.revoked).toContain('s9');
  });
});

// ===========================================================================
// Flags — over a real FeatureFlagsModule
// ===========================================================================

describe('flags ops (@velajs/studio/flags)', () => {
  const manifest = { alpha: true, label: 'hello' };

  it('feature is false without the subpath module', async () => {
    const app = await makeApp({}, [FeatureFlagsModule.forRoot({ manifest, isGlobal: true })]);
    expect(ok(await rpc(app, 'studio.capabilities')).features.flags).toBe(false);
  });

  it('lights the flags feature and lists / evaluates manifest flags', async () => {
    const app = await makeApp({}, [
      FeatureFlagsModule.forRoot({ manifest, isGlobal: true }),
      StudioFlagsModule.forRoot({}),
    ]);
    expect(ok(await rpc(app, 'studio.capabilities')).features.flags).toBe(true);

    const list = ok(await rpc(app, 'flags.list'));
    expect(list.find((f) => f.key === 'alpha')?.value).toBe(true);
    expect(list.find((f) => f.key === 'label')?.value).toBe('hello');

    const evalRes = ok(await rpc(app, 'flags.evaluate', { key: 'alpha' }));
    expect(evalRes.flagKey).toBe('alpha');
    expect(evalRes.value).toBe(true);
    expect(evalRes.reason).toBe('STATIC');
  });
});

// ===========================================================================
// Queue — over a real QueueModule
// ===========================================================================

@Processor('email')
@Injectable()
class EmailProcessor {
  @Process()
  handle() {}
}

@Module({ providers: [EmailProcessor] })
class EmailProcessorModule {}

describe('queue ops (@velajs/studio/queue)', () => {
  function queueApp(editable: Partial<StudioModuleOptions['editable']> = {}) {
    return makeApp({ editable: { ops: true, ...editable } }, [
      QueueModule.forRoot({ queues: ['email'] }),
      EmailProcessorModule,
      StudioQueueModule.forRoot({}),
    ]);
  }

  it('lights the queue feature and lists queues (kind, no depth)', async () => {
    const app = await queueApp();
    expect(ok(await rpc(app, 'studio.capabilities')).features.queue).toBe(true);
    const queues = ok(await rpc(app, 'queue.list'));
    expect(queues.map((q) => q.name)).toContain('email');
    expect(queues.every((q) => q.depth === undefined)).toBe(true);
  });

  it('send enqueues a job (opsEditable-gated); depths/dlq/replay degrade honestly', async () => {
    const app = await queueApp();
    const sent = ok(await rpc(app, 'queue.send', { queue: 'email', payload: { hi: 1 } }));
    expect(typeof sent.id).toBe('string');

    for (const op of ['queue.depths', 'queue.dlq', 'queue.replay'] as const) {
      const args =
        op === 'queue.dlq'
          ? { queue: 'email' }
          : op === 'queue.replay'
            ? { queue: 'email', ids: [] }
            : {};
      const res = await rpc(app, op, args as never);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected error');
      expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
    }
  });

  it('send gates on opsEditable (403 when closed)', async () => {
    const app = await queueApp({ ops: false });
    const res = await rpc(app, 'queue.send', { queue: 'email', payload: {} });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Schedule — over a real ScheduleModule
// ===========================================================================

@Injectable()
class Reports {
  ran = 0;
  @Cron('0 0 * * *')
  daily() {
    this.ran += 1;
  }
}

@Module({ providers: [Reports] })
class ReportsModule {}

describe('schedule ops (@velajs/studio/schedule)', () => {
  it('lists jobs + triggers and runs a job now (opsEditable-gated)', async () => {
    const app = await makeApp({ editable: { ops: true } }, [
      ScheduleModule,
      ReportsModule,
      StudioScheduleModule.forRoot({}),
    ]);
    expect(ok(await rpc(app, 'studio.capabilities')).features.schedule).toBe(true);

    const jobs = ok(await rpc(app, 'schedule.jobs'));
    const daily = jobs.find((j) => j.name === 'daily');
    expect(daily?.kind).toBe('cron');
    expect(daily?.expression).toBe('0 0 * * *');
    // Honest degradation: the registry tracks no run history.
    expect(daily?.lastRun).toBeUndefined();
    expect(daily?.nextRun).toBeUndefined();

    const triggers = ok(await rpc(app, 'schedule.triggers'));
    expect(triggers.find((t) => t.name === 'daily')?.cron).toBe('0 0 * * *');

    const reports = app.getContainer().resolve(Reports);
    expect(ok(await rpc(app, 'schedule.runNow', { id: 'daily' }))).toEqual({ ok: true });
    expect(reports.ran).toBe(1);
  });
});

// ===========================================================================
// Live / presence — honest degradation (no public enumeration in vela 1.20)
// ===========================================================================

describe('live / presence ops (@velajs/studio/live)', () => {
  it('lights live + presence by op-registration; both ops degrade honestly', async () => {
    const app = await makeApp({}, [StudioLiveModule.forRoot({})]);
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.live).toBe(true);
    expect(caps.features.presence).toBe(true);

    for (const op of ['live.subscriptions', 'presence.rooms'] as const) {
      const res = await rpc(app, op, {});
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected error');
      expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
    }
  });
});
