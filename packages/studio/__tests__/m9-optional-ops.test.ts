import {
  defineProvider,
  APP_EXCEPTION_HANDLER,
  Controller,
  EXECUTION_LIFETIME,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  UseGuards,
  VelaFactory,
  type CanActivate,
} from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import { Cron, Interval, ScheduleModule } from '@velajs/vela/schedule';
import type { ExecutionLifetime, ModuleImport, ProviderDefinition, Type } from '@velajs/vela';
import type { CronInvocation, ScheduleInvocation } from '@velajs/vela/schedule';
import type { RuntimeAdapter } from '@velajs/vela/module-kit';
import { CLOUDFLARE_SCHEDULED_EVENT, cloudflareAdapter } from '@velajs/cloudflare';
import type { CloudflareScheduledEvent } from '@velajs/cloudflare';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import { WebSocketModule } from '@velajs/vela/websocket';
import { LIVE_PLATFORM, LiveModule, localLive, type LivePlatform } from '@velajs/vela/live';
import { FeatureFlagsModule } from '@velajs/feature-flags';
import { BetterAuthService } from '@velajs/better-auth';
import { betterAuth } from 'better-auth';
import { admin, organization } from 'better-auth/plugins';
import { memoryAdapter } from 'better-auth/adapters/memory';
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
import { BetterAuthStudioSource } from '../src/auth';
import { flagsPanel } from '../src/flags';
import { queuesPanel } from '../src/queue';
import { schedulePanel } from '../src/schedule';
import { livePanel } from '../src/live';
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
  env?: object,
): Promise<AdminRpcResponse<StudioOpRes<Op>>> {
  const res = await app
    .getHonoApp()
    .request(`${BASE}/rpc/${op}`, authed(args !== undefined ? { args } : {}), env);
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

/** Assert an op response degraded to the `FEATURE_UNCONFIGURED` error (never ok, never 500). */
function expectUnconfigured<T>(res: AdminRpcResponse<T>): void {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error(`expected FEATURE_UNCONFIGURED, got ${JSON.stringify(res)}`);
  expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
  expect(res.status).not.toBe(500);
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
      supports: { bulkWrites: true, facets: false, search: false, cascade: false },
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
    providers: [defineProvider(STUDIO_MODEL_SOURCE, { useValue: source })],
    exports: [STUDIO_MODEL_SOURCE],
  })
  class SourceModule {}
  return SourceModule;
}

async function makeApp(
  studio: Partial<StudioModuleOptions> = {},
  imports: ModuleImport[] = [],
  extra: Array<Type | ProviderDefinition> = [],
  adapters: RuntimeAdapter[] = [],
): Promise<App> {
  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, ...studio }), ...imports],
    providers: extra,
  })
  class AppModule {}
  return VelaFactory.create(AppModule, { adapters });
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
    providers: [defineProvider(STUDIO_AUTH_SOURCE, { useValue: source })],
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
// Auth — over a REAL better-auth (admin + organization) via the trusted DATA
// layer (`auth.$context` → internalAdapter / adapter), NOT the authz HTTP API.
// ===========================================================================

/** A real betterAuth instance (admin + organization) over an in-memory adapter. */
function realBetterAuth(db: Record<string, unknown[]>) {
  return betterAuth({
    baseURL: 'http://localhost',
    secret: 'studio-auth-test-secret-please-ignore-0123456789',
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    plugins: [admin(), organization()],
    logger: { disabled: true },
  });
}

/** The model arrays the memory adapter needs pre-seeded (it throws on an unwritten table). */
function seededDb(): Record<string, unknown[]> {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
}

describe('auth ops (over real better-auth via the trusted data layer)', () => {
  it('lists users/detail/sessions/orgs + revokes a session through the trusted path', async () => {
    const auth = realBetterAuth(seededDb());
    const ctx = await auth.$context;
    const u1 = await ctx.internalAdapter.createUser(
      { email: 'ann@x.io', name: 'Ann' },
      { method: 'admin' },
    );
    const u2 = await ctx.internalAdapter.createUser(
      { email: 'bob@x.io', name: 'Bob' },
      { method: 'admin' },
    );
    const session = await ctx.internalAdapter.createSession(u1.id, false, {
      ipAddress: '10.0.0.9',
      userAgent: 'vela-studio-test',
    });
    await ctx.adapter.create({
      model: 'organization',
      data: { name: 'Acme', slug: 'acme', createdAt: new Date() },
    });

    const source = new BetterAuthStudioSource(new BetterAuthService(() => auth));
    const app = await makeApp({ editable: { ops: true } }, [authModule(source)]);

    // Capabilities light off the wired plugins (admin + organization).
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.auth).toBe(true);
    expect(caps.features.authOrganizations).toBe(true);

    // Users read through internalAdapter.listUsers (no admin session required).
    const users = ok(await rpc(app, 'auth.users', {}));
    expect(users.rows.map((u) => u.email).toSorted()).toEqual(['ann@x.io', 'bob@x.io']);

    // Search filters via a `contains` clause on email.
    const filtered = ok(await rpc(app, 'auth.users', { q: 'bob' }));
    expect(filtered.rows.map((u) => u.email)).toEqual(['bob@x.io']);

    // userDetail resolves by DIRECT id lookup (NOT limited to the first page).
    const detail = ok(await rpc(app, 'auth.userDetail', { id: u2.id }));
    expect(detail.user.email).toBe('bob@x.io');

    // Sessions read per-user; the created session shows up.
    const sessions = ok(await rpc(app, 'auth.sessions', { userId: u1.id }));
    expect(sessions.map((s) => s.id)).toContain(session.id);

    // Revoke by the session's own id → deleted through the raw adapter.
    expect(ok(await rpc(app, 'auth.revokeSession', { sessionId: session.id }))).toEqual({
      ok: true,
    });
    expect(ok(await rpc(app, 'auth.sessions', { userId: u1.id }))).toEqual([]);

    // Organizations read through the raw adapter.findMany.
    const orgs = ok(await rpc(app, 'auth.organizations', {}));
    expect(orgs.map((o) => o.name)).toEqual(['Acme']);
  });

  it('maps a thrown trusted-layer failure to FEATURE_UNCONFIGURED (never a raw 500)', async () => {
    // Unseeded memory db: every trusted-layer read/delete THROWS (model not in DB)
    // — the same class of failure a thrown better-auth APIError would produce.
    const auth = realBetterAuth({});
    const source = new BetterAuthStudioSource(new BetterAuthService(() => auth));
    const app = await makeApp({ editable: { ops: true } }, [authModule(source)]);

    // The features still light (plugins ARE wired); the failure is at read time.
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.auth).toBe(true);
    expect(caps.features.authOrganizations).toBe(true);

    expectUnconfigured(await rpc(app, 'auth.users', {}));
    expectUnconfigured(await rpc(app, 'auth.userDetail', { id: 'nope' }));
    expectUnconfigured(await rpc(app, 'auth.sessions', { userId: 'u1' }));
    expectUnconfigured(await rpc(app, 'auth.revokeSession', { sessionId: 's1' }));
    expectUnconfigured(await rpc(app, 'auth.organizations', {}));
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
    const app = await makeApp({ plugins: [flagsPanel()] }, [
      FeatureFlagsModule.forRoot({ manifest, isGlobal: true }),
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
class EmailProcessor {
  @Process()
  handle() {}
}

@Module({ providers: [EmailProcessor] })
class EmailProcessorModule {}

describe('queue ops (@velajs/studio/queue)', () => {
  function queueApp(editable: Partial<StudioModuleOptions['editable']> = {}) {
    return makeApp({ editable: { ops: true, ...editable }, plugins: [queuesPanel()] }, [
      QueueModule.forRoot(),
      QueueModule.forFeature([{ name: 'email' }, { name: 'audit' }]),
      EmailProcessorModule,
    ]);
  }

  it('lights the queue feature and lists queues (kind, no depth)', async () => {
    const app = await queueApp();
    expect(ok(await rpc(app, 'studio.capabilities')).features.queue).toBe(true);
    const queues = ok(await rpc(app, 'queue.list'));
    // Registered queues are listed whether or not this app processes them.
    expect(queues).toEqual([
      { name: 'audit', kind: 'inline' },
      { name: 'email', kind: 'inline' },
    ]);
  });

  it('send enqueues a job (opsEditable-gated); depths/dlq/replay degrade honestly', async () => {
    const app = await queueApp();
    const sent = ok(await rpc(app, 'queue.send', { queue: 'email', payload: { hi: 1 } }));
    expect(typeof sent.id).toBe('string');
    const missing = await rpc(app, 'queue.send', { queue: 'missing', payload: {} });
    expect(missing.ok).toBe(false);

    // Per-op typed calls (no `as never`): each degrades honestly.
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.operations).toContain('queue.send');
    expect(caps.operations).not.toContain('queue.depths');
    expect(caps.operations).not.toContain('queue.dlq');
    expect(caps.operations).not.toContain('queue.replay');
    expectUnconfigured(await rpc(app, 'queue.depths', {}));
    expectUnconfigured(await rpc(app, 'queue.dlq', { queue: 'email' }));
    expectUnconfigured(await rpc(app, 'queue.replay', { queue: 'email', ids: [] }));
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
    const app = await makeApp({ editable: { ops: true }, plugins: [schedulePanel()] }, [
      ScheduleModule,
      ReportsModule,
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

  it('lists request-scoped and lazy jobs without materializing them, and runs them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ran: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Scoped {
      @Cron('0 6 * * *', { dialect: 'cloudflare' })
      morning() {
        ran.push('morning');
      }
      @Interval(60_000)
      poll() {
        ran.push('poll');
      }
    }
    @Module({ providers: [Scoped] })
    class ScopedModule {}
    @Injectable()
    class Deferred {
      @Cron('0 1 * * *', { dialect: 'cloudflare' })
      nightly() {
        ran.push('nightly');
      }
    }
    @Module({ lazy: true, providers: [Deferred] })
    class DeferredModule {}
    const app = await makeApp({ editable: { ops: true }, plugins: [schedulePanel()] }, [
      ScheduleModule,
      ScopedModule,
      DeferredModule,
    ]);
    try {
      const jobs = ok(await rpc(app, 'schedule.jobs'));
      expect(jobs).toEqual(
        expect.arrayContaining([
          { name: 'morning', kind: 'cron', expression: '0 6 * * *' },
          { name: 'nightly', kind: 'cron', expression: '0 1 * * *' },
          { name: 'poll', kind: 'interval', ms: 60_000 },
        ]),
      );
      expect(jobs).toHaveLength(3);
      const triggers = ok(await rpc(app, 'schedule.triggers'));
      expect(triggers.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'morning', cron: '0 6 * * *' },
        { name: 'nightly', cron: '0 1 * * *' },
      ]);
      // Listing reads metadata: nothing is skipped or materialized.
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/skipped/);
      expect(ran).toEqual([]);

      for (const id of ['morning', 'poll', 'nightly']) {
        expect(ok(await rpc(app, 'schedule.runNow', { id }))).toEqual({ ok: true });
      }
      expect(ran).toEqual(['morning', 'poll', 'nightly']);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('refuses to run now a direct job that declares guards, as a trigger would', async () => {
    const ran: string[] = [];
    const report = vi.fn();
    class Allow implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }
    @Injectable()
    @UseGuards(Allow)
    class Guarded {
      @Cron('0 7 * * *', { dialect: 'cloudflare' })
      morning() {
        ran.push('morning');
      }
    }
    @Module({ providers: [Guarded] })
    class GuardedModule {}
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeApp(
      { editable: { ops: true }, plugins: [schedulePanel()] },
      [ScheduleModule, GuardedModule],
      [defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } })],
    );
    try {
      const res = await rpc(app, 'schedule.runNow', { id: 'morning' });

      expect(res.ok).toBe(false);
      expect(ran).toEqual([]);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(
            /Guarded\.morning declares @UseGuards, but guards do not run for directly dispatched scheduled jobs/,
          ),
        }),
        expect.objectContaining({ edge: 'schedule', source: 'Guarded.morning' }),
      );
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('runs a job now exactly as a trigger would, including request-scoped jobs', async () => {
    const ticks: ScheduleInvocation[] = [];
    const scopes = new Set<Digest>();
    @Injectable({ scope: Scope.REQUEST })
    class Digest {
      @Cron('0 6 * * *', { dialect: 'cloudflare' })
      morning(...args: ScheduleInvocation[]) {
        scopes.add(this);
        ticks.push(...args);
      }
      @Interval(60_000)
      poll(...args: ScheduleInvocation[]) {
        ticks.push(...args);
      }
    }
    @Module({ providers: [Digest] })
    class DigestModule {}
    const app = await makeApp({ editable: { ops: true }, plugins: [schedulePanel()] }, [
      ScheduleModule,
      DigestModule,
    ]);
    try {
      const before = Date.now();
      expect(ok(await rpc(app, 'schedule.runNow', { id: 'morning' }))).toEqual({ ok: true });
      expect(ok(await rpc(app, 'schedule.runNow', { id: 'morning' }))).toEqual({ ok: true });
      expect(ok(await rpc(app, 'schedule.runNow', { id: 'poll' }))).toEqual({ ok: true });

      expect(scopes.size).toBe(2);
      expect(ticks).toHaveLength(3);
      expect(ticks[0]).toMatchObject({ kind: 'cron', expression: '0 6 * * *' });
      expect(ticks[2]).toMatchObject({ kind: 'interval', ms: 60_000 });
      expect(ticks.every((tick) => tick.scheduledTime >= before && !tick.signal.aborted)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });
});

describe('schedule run-now on the Cloudflare adapter', () => {
  it('runs a job that reads the scheduled trigger event, as a cron trigger would', async () => {
    const seen: Array<{ cron: string; expression: string; scheduledTime: number }> = [];
    @Injectable({ scope: Scope.REQUEST })
    class Exports {
      constructor(
        @Inject(CLOUDFLARE_SCHEDULED_EVENT) private readonly trigger: CloudflareScheduledEvent,
        @Inject(EXECUTION_LIFETIME) private readonly lifetime: ExecutionLifetime,
      ) {}
      @Cron('30 2 * * *', { dialect: 'cloudflare' })
      async nightly(tick: CronInvocation) {
        this.trigger.noRetry();
        this.lifetime.waitUntil(
          Promise.resolve().then(() => {
            seen.push({
              cron: this.trigger.cron,
              expression: tick.expression,
              scheduledTime: this.trigger.scheduledTime,
            });
          }),
        );
      }
    }
    @Module({ providers: [Exports] })
    class ExportsModule {}
    const env = {};
    const app = await makeApp(
      { editable: { ops: true }, plugins: [schedulePanel()] },
      [ScheduleModule, ExportsModule],
      [],
      [cloudflareAdapter({ env })],
    );
    try {
      // The documented request-scoped job appears in the panel.
      expect(ok(await rpc(app, 'schedule.jobs', undefined, env))).toEqual([
        { name: 'nightly', kind: 'cron', expression: '30 2 * * *' },
      ]);
      const before = Date.now();
      expect(ok(await rpc(app, 'schedule.runNow', { id: 'nightly' }, env))).toEqual({ ok: true });
      expect(seen).toEqual([
        { cron: '30 2 * * *', expression: '30 2 * * *', scheduledTime: expect.any(Number) },
      ]);
      expect(seen[0]!.scheduledTime).toBeGreaterThanOrEqual(before);
    } finally {
      await app.close();
    }
  });

  it('aborts a running run-now invocation when the application closes', async () => {
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    @Injectable()
    class Slow {
      @Cron('0 5 * * *', { dialect: 'cloudflare' })
      async drain(tick: CronInvocation) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          tick.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
    @Module({ providers: [Slow] })
    class SlowModule {}
    const app = await makeApp({ editable: { ops: true }, plugins: [schedulePanel()] }, [
      ScheduleModule,
      SlowModule,
    ]);
    const running = rpc(app, 'schedule.runNow', { id: 'drain' });
    await entered.promise;
    await app.close();
    expect(aborted).toBe(true);
    expect(ok(await running)).toEqual({ ok: true });
  });
});

// ===========================================================================
// Live / presence — explicit inspection sources and default-closed capabilities
// ===========================================================================

describe('live / presence ops (@velajs/studio/live)', () => {
  it('advertises a configured source and protects its snapshots with admin authentication', async () => {
    const snapshot = {
      subscriptions: [
        { id: 'sub-1', room: 'default', tags: ['todos'], connectedAt: 100, clientId: 'client-1' },
      ],
      rooms: [{ room: 'default', count: 1, members: ['client-1'] }],
    };
    let reads = 0;
    const app = await makeApp({
      plugins: [
        livePanel({
          source: {
            inspect: async () => {
              reads++;
              return structuredClone(snapshot);
            },
          },
        }),
      ],
    });
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.live).toBe(true);
    expect(caps.features.presence).toBe(true);
    const denied = await app.getHonoApp().request(`${BASE}/rpc/live.subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(401);
    expect(reads).toBe(0);
    expect(ok(await rpc(app, 'live.subscriptions'))).toEqual(snapshot.subscriptions);
    expect(ok(await rpc(app, 'presence.rooms'))).toEqual(snapshot.rooms);
    await app.close();
  });

  it("inspects the named rooms where LiveModule's platform keeps their subscriptions", async () => {
    const inspected: string[] = [];
    const platform: LivePlatform = {
      liveDriver: () => localLive(),
      async inspect(room) {
        inspected.push(room);
        return {
          subscriptions: [
            {
              id: `${room}-sub`,
              query: 'todos.list',
              room,
              clientId: `${room}-client`,
              tags: ['todos'],
              connectedAt: 100,
            },
          ],
          rooms: [{ room, count: 1, members: [`${room}-client`] }],
        };
      },
    };
    const livePlatform: RuntimeAdapter = {
      name: 'test-live-platform',
      configureContainer(container) {
        container.register(defineProvider(LIVE_PLATFORM, { useValue: platform }));
        container.markGlobalToken(LIVE_PLATFORM);
      },
    };
    const app = await makeApp(
      { plugins: [livePanel({ rooms: ['default', 'org-1'] })] },
      [WebSocketModule.forRoot(), LiveModule.forRoot()],
      [],
      [livePlatform],
    );
    try {
      const caps = ok(await rpc(app, 'studio.capabilities'));
      expect(caps.features.live).toBe(true);
      expect(inspected).toEqual([]);
      expect(ok(await rpc(app, 'live.subscriptions'))).toEqual([
        {
          id: 'default-sub',
          room: 'default',
          tags: ['todos'],
          connectedAt: 100,
          clientId: 'default-client',
        },
        {
          id: 'org-1-sub',
          room: 'org-1',
          tags: ['todos'],
          connectedAt: 100,
          clientId: 'org-1-client',
        },
      ]);
      expect(ok(await rpc(app, 'presence.rooms'))).toEqual([
        { room: 'default', count: 1, members: ['default-client'] },
        { room: 'org-1', count: 1, members: ['org-1-client'] },
      ]);
      expect(inspected).toEqual(['default', 'org-1', 'default', 'org-1']);
    } finally {
      await app.close();
    }
  });

  it('requires LiveModule to inspect named rooms, and one source of rows', async () => {
    await expect(makeApp({ plugins: [livePanel({ rooms: ['default'] })] })).rejects.toThrow(
      /livePanel\(\{ rooms \}\).*LiveModule\.forRoot\(\)/,
    );
    expect(() =>
      livePanel({
        rooms: ['default'],
        source: { inspect: async () => ({ subscriptions: [], rooms: [] }) },
      }),
    ).toThrow(/either rooms or source/);
  });

  it('does not advertise live + presence handlers without introspection support', async () => {
    const app = await makeApp({ plugins: [livePanel()] });
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.live).toBe(false);
    expect(caps.features.presence).toBe(false);
    expect(caps.operations).not.toContain('live.subscriptions');
    expect(caps.operations).not.toContain('presence.rooms');

    for (const op of ['live.subscriptions', 'presence.rooms'] as const) {
      const res = await rpc(app, op, {});
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected error');
      expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
    }
  });
});
