import { z } from 'zod';
import { Crud } from '@velajs/crud';
import { matchesPredicate } from '@velajs/crud/query';
import { bindAdapter } from '@velajs/crud/adapter';
import { defineProvider, Controller, Module, VelaFactory } from '@velajs/vela';
import { describe, expect, it } from 'vitest';
import { MemoryAuditStore } from '@velajs/crud/audit';
import type { Model, RelationConfig } from '@velajs/crud/model';
import type {
  AdapterScope,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
  FilterOperator,
  ListQuery,
  Lookup,
  Page,
  ReadOptions,
} from '@velajs/crud/adapter';
import {
  ConfirmTokenSigner,
  InMemorySnapshotStore,
  SnapshotTimeTravelAdapter,
  StudioModule,
  TIME_TRAVEL_PORT,
} from '../src';
import type {
  ChangeSource,
  LiveInvalidatorPort,
  StudioConfirmChallenge,
  StudioModelSource,
  StudioModuleOptions,
  StudioWriteContext,
  StudioWriteRowOutcome,
} from '../src';
import { AuditStoreChangeSource, crudPanel } from '../src/crud';
import { timeTravelPanel } from '../src/timetravel';
import type { TimeTravelPanelOptions } from '../src/timetravel';
import type {
  AdminRpcResponse,
  ClearTableRequest,
  DeleteRowsRequest,
  ListRowsRequest,
  RestoreOutcome,
  RestorePreview,
  RestoreRequest,
  StudioChange,
  StudioColumn,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
  StudioRowPage,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelPort,
  WriteRowRequest,
} from '@velajs/studio-protocol';

type Row = Record<string, unknown>;

// ===========================================================================
// A minimal write-capable StudioModelSource with a MUTABLE column schema, so
// the adapter's snapshot/restore/CDC logic can be exercised in isolation.
// ===========================================================================

interface FakeModel {
  name: string;
  table: string;
  pk: string;
  columns: StudioColumn[];
  rows: Map<string, Row>;
}

function col(
  name: string,
  type: StudioColumn['type'],
  extra: Partial<StudioColumn> = {},
): StudioColumn {
  return { name, type, pk: false, nullable: false, unique: false, managed: false, ...extra };
}

class FakeModelSource implements StudioModelSource {
  readonly models = new Map<string, FakeModel>();

  define(model: FakeModel): void {
    this.models.set(model.name, model);
  }

  private get(model: string): FakeModel {
    const m = this.models.get(model);
    if (m === undefined) throw new Error(`unknown model ${model}`);
    return m;
  }

  listModels(): StudioModelInfo[] {
    return [...this.models.values()].map((m) => ({
      name: m.name,
      table: m.table,
      label: m.name,
      capabilities: [],
    }));
  }

  describe(model: string): StudioModelDescriptor {
    const m = this.get(model);
    return {
      name: m.name,
      table: m.table,
      primaryKeys: [m.pk],
      columns: m.columns,
      relations: [],
      flags: { softDelete: false, multiTenant: false, versioning: false, audit: false },
      supports: { bulkWrites: true, facets: false, search: false, cascade: false },
    };
  }

  async list(model: string, request: ListRowsRequest): Promise<StudioRowPage> {
    const m = this.get(model);
    const all = [...m.rows.values()];
    const page = request.page ?? 1;
    const perPage = request.perPage ?? 20;
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return {
      rows: slice.map((r) => ({ ...r })),
      info: {
        page,
        per_page: perPage,
        total_count: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        has_next_page: page * perPage < all.length,
        has_prev_page: page > 1,
      },
    };
  }

  async readOne(model: string, id: string): Promise<Row | null> {
    return this.get(model).rows.get(id) ?? null;
  }

  async writeRow(
    model: string,
    request: WriteRowRequest,
    _ctx: StudioWriteContext,
  ): Promise<StudioWriteRowOutcome> {
    const m = this.get(model);
    if (request.id !== undefined) {
      const before = m.rows.get(request.id) ?? null;
      const after = { ...(before ?? {}), ...request.patch };
      m.rows.set(request.id, after);
      return { after, before };
    }
    const after = { ...request.patch };
    m.rows.set(String(after[m.pk]), after);
    return { after, before: null };
  }

  async deleteRows(
    model: string,
    request: DeleteRowsRequest,
    _ctx: StudioWriteContext,
  ): Promise<{ deleted: number; before: Row[]; beforeCapped: boolean }> {
    const m = this.get(model);
    let deleted = 0;
    for (const id of request.ids) if (m.rows.delete(id)) deleted += 1;
    return { deleted, before: [], beforeCapped: false };
  }

  async clearTable(
    model: string,
    _request: ClearTableRequest,
    _ctx: StudioWriteContext,
  ): Promise<{ deleted: number }> {
    const m = this.get(model);
    const deleted = m.rows.size;
    m.rows.clear();
    return { deleted };
  }
}

class RecordingLiveInvalidator implements LiveInvalidatorPort {
  readonly calls: string[][] = [];
  async invalidateTables(tables: readonly string[]): Promise<void> {
    this.calls.push([...tables]);
  }
}

class FakeChangeSource implements ChangeSource {
  constructor(private readonly changes: StudioChange[]) {}
  async changesBetween(table: string, fromTs: number, toTs: number): Promise<StudioChange[]> {
    return this.changes
      .filter((c) => c.table === table && c.ts > fromTs && c.ts <= toTs)
      .toSorted((a, b) => a.ts - b.ts);
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** The undo-mark id a restore failure surfaces on its error `data.undoMark`, if any. */
function undoMarkFromError(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('data' in err)) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null || !('undoMark' in data)) return undefined;
  const undoMark = (data as { undoMark?: unknown }).undoMark;
  return typeof undoMark === 'string' ? undoMark : undefined;
}

function userSource(): FakeModelSource {
  const source = new FakeModelSource();
  source.define({
    name: 'user',
    table: 'users',
    pk: 'id',
    columns: [col('id', 'string', { pk: true, unique: true }), col('email', 'string')],
    rows: new Map([
      ['u1', { id: 'u1', email: 'ann@x.io' }],
      ['u2', { id: 'u2', email: 'bob@x.io' }],
    ]),
  });
  return source;
}

function makeAdapter(
  source: FakeModelSource,
  extra: { live?: LiveInvalidatorPort; changeSource?: ChangeSource; now?: () => number } = {},
): SnapshotTimeTravelAdapter {
  return new SnapshotTimeTravelAdapter({
    store: new InMemorySnapshotStore(),
    source,
    confirm: new ConfirmTokenSigner('adapter-secret'),
    ...(extra.live !== undefined ? { live: extra.live } : {}),
    ...(extra.changeSource !== undefined ? { changeSource: extra.changeSource } : {}),
    ...(extra.now !== undefined ? { now: extra.now } : {}),
  });
}

// ===========================================================================
// Adapter-level tests
// ===========================================================================

describe('SnapshotTimeTravelAdapter — capabilities', () => {
  it('advertises the portable shape; granularity flips to snapshot+cdc with a change source', () => {
    const caps = makeAdapter(userSource()).capabilities();
    expect(caps).toMatchObject({
      markByTime: true,
      list: true,
      undo: true,
      inPlace: true,
      restartRequired: false,
      portableExport: true,
      createOnDemand: true,
      granularity: 'snapshot',
    });
    expect(caps.scopeNote.length).toBeGreaterThan(0);

    const cdcCaps = makeAdapter(userSource(), {
      changeSource: new FakeChangeSource([]),
    }).capabilities();
    expect(cdcCaps.granularity).toBe('snapshot+cdc');
  });
});

describe('SnapshotTimeTravelAdapter — snapshot/restore round-trip', () => {
  it('restores rows to the exact snapshot state (create/update/delete are undone)', async () => {
    const source = userSource();
    const adapter = makeAdapter(source);

    const mark = await adapter.createSnapshot({ label: 'baseline' });
    expect(mark.tables).toEqual(['user']);

    // Mutate: edit u1, delete u2, add u3.
    source.models.get('user')!.rows.set('u1', { id: 'u1', email: 'ANN@x.io' });
    source.models.get('user')!.rows.delete('u2');
    source.models.get('user')!.rows.set('u3', { id: 'u3', email: 'cat@x.io' });

    const preview = await adapter.preview({ bookmark: mark.id });
    expect(preview.schemaCompatible).toBe(true);
    expect(preview.affectedTables).toEqual([{ table: 'user', approxRows: 2 }]);
    expect(preview.confirmToken.length).toBeGreaterThan(0);

    const outcome = await adapter.armRestore(arm(mark.id, preview.confirmToken));
    expect(outcome.applied).toBe(true);
    expect(outcome.restartRequested).toBe(false);
    expect(outcome.restoredTo).toBe(mark.id);
    expect(outcome.undoMark).toBeDefined();

    const rows = source.models.get('user')!.rows;
    expect([...rows.keys()].toSorted()).toEqual(['u1', 'u2']);
    expect(rows.get('u1')).toEqual({ id: 'u1', email: 'ann@x.io' });
    expect(rows.has('u3')).toBe(false);
  });

  it('undo returns to the pre-restore state via the returned undoMark', async () => {
    const source = userSource();
    const adapter = makeAdapter(source);
    const mark = await adapter.createSnapshot();

    // Diverge, then restore (capturing an undo of the diverged state).
    source.models.get('user')!.rows.set('u3', { id: 'u3', email: 'cat@x.io' });
    const restore = await adapter.armRestore(arm(mark.id, ''));
    expect(source.models.get('user')!.rows.has('u3')).toBe(false);

    const undoMark = restore.undoMark;
    expect(undoMark).toBeDefined();
    // Undo == restore to the undo mark → the diverged state (with u3) returns.
    await adapter.armRestore(arm(undoMark!.id, ''));
    expect(source.models.get('user')!.rows.has('u3')).toBe(true);
  });
});

describe('SnapshotTimeTravelAdapter — schema compatibility', () => {
  it('flags an incompatible schema and blocks restore unless forced', async () => {
    const source = userSource();
    const adapter = makeAdapter(source);
    const mark = await adapter.createSnapshot();

    // Evolve the schema: add a column → the current schemaHash diverges.
    source.models.get('user')!.columns.push(col('age', 'number', { nullable: true }));

    const preview = await adapter.preview({ bookmark: mark.id });
    expect(preview.schemaCompatible).toBe(false);
    expect(preview.incompatibleTables).toEqual(['user']);

    await expect(adapter.armRestore(arm(mark.id, preview.confirmToken))).rejects.toSatisfy(
      (err: unknown) => errorCode(err) === 'TIMETRAVEL_SCHEMA_MISMATCH',
    );

    // force overrides the mismatch and applies the restore.
    const forced = await adapter.armRestore({ ...arm(mark.id, ''), force: true });
    expect(forced.applied).toBe(true);
  });
});

describe('SnapshotTimeTravelAdapter — live invalidation', () => {
  it('fires crud:<table> invalidation for affected tables after a restore', async () => {
    const source = userSource();
    const live = new RecordingLiveInvalidator();
    const adapter = makeAdapter(source, { live });
    const mark = await adapter.createSnapshot();
    live.calls.length = 0; // ignore any snapshot-time noise (there is none, but be explicit)

    await adapter.armRestore(arm(mark.id, ''));
    expect(live.calls).toEqual([['users']]); // table name, not model name
  });
});

describe('SnapshotTimeTravelAdapter — marks + export + prune', () => {
  it('lists marks newest-first and resolves current + by-time marks', async () => {
    const source = userSource();
    let clock = 1000;
    const adapter = makeAdapter(source, { now: () => clock });

    const a = await adapter.createSnapshot();
    clock = 2000;
    const b = await adapter.createSnapshot();

    const marks = await adapter.listMarks();
    expect(marks.marks.map((m) => m.id)).toEqual([b.id, a.id]);

    const current = await adapter.getCurrentMark();
    expect(current.id).toBe(b.id);

    const atTime = await adapter.getMarkForTime(1500);
    expect(atTime?.id).toBe(a.id); // latest at-or-before 1500
    expect(await adapter.getMarkForTime(500)).toBeNull();
  });

  it('exports a snapshot as a self-describing NDJSON stream', async () => {
    const source = userSource();
    const adapter = makeAdapter(source);
    const mark = await adapter.createSnapshot();
    const stream = await adapter.exportSnapshot(mark.id);
    const text = await new Response(stream).text();
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toHaveProperty('manifest');
    expect(lines.some((l) => l.table === 'user')).toBe(true);
    expect(lines.some((l) => l.id === 'u1' && l.email === 'ann@x.io')).toBe(true);
  });

  it('prunes by keepLast retention', async () => {
    const source = userSource();
    let clock = 1000;
    const adapter = makeAdapter(source, { now: () => clock });
    for (let i = 0; i < 4; i++) {
      clock += 1000;
      await adapter.createSnapshot();
    }
    expect((await adapter.listMarks()).marks.length).toBe(4);
    const pruned = await adapter.prune({ keepLast: 2 });
    expect(pruned.pruned).toBe(2);
    expect((await adapter.listMarks()).marks.length).toBe(2);
  });
});

describe('SnapshotTimeTravelAdapter — CDC replay (snapshot+cdc)', () => {
  it('replays changes between a snapshot and a mid-window time', async () => {
    const source = userSource();
    let clock = 1000;
    // Changes committed AFTER the snapshot at t=1000, in window (1000, 1500].
    const changes: StudioChange[] = [
      {
        ts: 1100,
        table: 'users',
        kind: 'update',
        key: { id: 'u1' },
        after: { id: 'u1', email: 'ann+edited@x.io' },
      },
      {
        ts: 1200,
        table: 'users',
        kind: 'insert',
        key: { id: 'u9' },
        after: { id: 'u9', email: 'zed@x.io' },
      },
      { ts: 1300, table: 'users', kind: 'delete', key: { id: 'u2' } },
      // A later change OUTSIDE the window must NOT be replayed.
      {
        ts: 1800,
        table: 'users',
        kind: 'insert',
        key: { id: 'u5' },
        after: { id: 'u5', email: 'late@x.io' },
      },
    ];
    const adapter = makeAdapter(source, {
      changeSource: new FakeChangeSource(changes),
      now: () => clock,
    });

    const snap = await adapter.createSnapshot(); // captures {u1:ann, u2:bob} at t=1000
    clock = 5000;
    // Diverge live state, then restore-to-a-time at 1500 → base snapshot + replay.
    source.models.get('user')!.rows.set('u1', { id: 'u1', email: 'garbage' });

    await adapter.armRestore({ time: 1500, confirmToken: '' });

    const rows = source.models.get('user')!.rows;
    expect(rows.get('u1')).toEqual({ id: 'u1', email: 'ann+edited@x.io' }); // replayed update
    expect(rows.get('u9')).toEqual({ id: 'u9', email: 'zed@x.io' }); // replayed insert
    expect(rows.has('u2')).toBe(false); // replayed delete
    expect(rows.has('u5')).toBe(false); // outside the window — not replayed
    // markForTime resolves the base snapshot for that time.
    expect((await adapter.getMarkForTime(1500))?.id).toBe(snap.id);
  });
});

describe('SnapshotTimeTravelAdapter — non-atomic restore recovery', () => {
  it('surfaces the pre-captured undo mark id on the error when a restore throws mid-way', async () => {
    const source = userSource();
    const original = source.writeRow.bind(source);
    let failWrites = false;
    // Fail the restore RELOAD (writeRow) — after the undo snapshot (which only
    // reads) has been captured — to simulate a partial, non-atomic restore.
    source.writeRow = async (
      model: string,
      request: WriteRowRequest,
      ctx: StudioWriteContext,
    ): Promise<StudioWriteRowOutcome> => {
      if (failWrites) throw new Error('backing store failure mid-restore');
      return original(model, request, ctx);
    };
    const adapter = makeAdapter(source);
    const mark = await adapter.createSnapshot();

    source.models.get('user')!.rows.set('u3', { id: 'u3', email: 'cat@x.io' });
    failWrites = true;

    const error = await adapter.armRestore(arm(mark.id, '')).then(
      () => {
        throw new Error('expected the restore to throw');
      },
      (e: unknown) => e,
    );

    // The failure is a conflict that names the undo mark id (the recovery target).
    expect(errorCode(error)).toBe('conflict');
    const undoMarkId = undoMarkFromError(error);
    expect(typeof undoMarkId).toBe('string');
    expect(undoMarkId).toMatch(/^snap-/);

    // The surfaced id is a real, listable snapshot — a caller can restore to it.
    failWrites = false;
    const marks = await adapter.listMarks();
    expect(marks.marks.some((m) => m.id === undoMarkId)).toBe(true);
  });
});

// ===========================================================================
// AuditStoreChangeSource (crud subpath) — maps @velajs/crud/audit → StudioChange
// ===========================================================================

describe('AuditStoreChangeSource', () => {
  it('maps audit entries to StudioChange within the half-open window', async () => {
    const store = new MemoryAuditStore();
    await store.log({
      id: 'a1',
      timestamp: new Date(1100),
      action: 'create',
      tableName: 'users',
      recordId: 'u9',
      record: { id: 'u9', email: 'zed@x.io' },
    });
    await store.log({
      id: 'a2',
      timestamp: new Date(1200),
      action: 'update',
      tableName: 'users',
      recordId: 'u1',
      previousRecord: { id: 'u1', email: 'ann@x.io' },
      record: { id: 'u1', email: 'ann2@x.io' },
    });
    await store.log({
      id: 'a3',
      timestamp: new Date(1300),
      action: 'delete',
      tableName: 'users',
      recordId: 'u2',
      previousRecord: { id: 'u2', email: 'bob@x.io' },
    });
    // Boundary: ts === fromTs is excluded (half-open); ts outside window excluded.
    await store.log({
      id: 'a0',
      timestamp: new Date(1000),
      action: 'create',
      tableName: 'users',
      recordId: 'u0',
      record: { id: 'u0' },
    });

    const cdc = new AuditStoreChangeSource(store);
    const changes = await cdc.changesBetween('users', 1000, 1300);
    expect(changes.map((c) => [c.ts, c.kind])).toEqual([
      [1100, 'insert'],
      [1200, 'update'],
      [1300, 'delete'],
    ]);
    expect(changes[1]?.after).toEqual({ id: 'u1', email: 'ann2@x.io' });
  });
});

/** A minimal RestoreRequest addressing a bookmark with a (registry-verified) token. */
function arm(bookmark: string, confirmToken: string): RestoreRequest {
  return { bookmark, confirmToken };
}

// ===========================================================================
// Integration: full HTTP dispatch through StudioModule + timeTravelPanel()
// ===========================================================================

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

function zSchema(shape: Record<string, { type: string; optional?: boolean }>): Model['schema'] {
  return z.object(
    Object.fromEntries(
      Object.entries(shape).map(([name, spec]) => {
        const field = spec.type === 'number' ? z.number() : z.string();
        return [name, spec.optional ? field.optional() : field];
      }),
    ),
  );
}

const widgetModel: Model = {
  name: 'widget',
  namePlural: 'widgets',
  tableName: 'widgets',
  schema: zSchema({
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'number', optional: true },
    updatedAt: { type: 'number', optional: true },
  }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  versioning: false,
  audit: false,
  relations: {} as Record<string, RelationConfig>,
};

class MemoryDb {
  readonly tables = new Map<string, Map<string, Row>>();
  table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (t === undefined) {
      t = new Map<string, Row>();
      this.tables.set(name, t);
    }
    return t;
  }
}

const str = (v: unknown): string => (v == null ? '' : String(v));

function matchFilter(value: unknown, operator: FilterOperator, needle: unknown): boolean {
  return operator === 'eq'
    ? str(value) === str(needle)
    : operator === 'ne'
      ? str(value) !== str(needle)
      : true;
}

function memoryAdapter(model: Model, db: MemoryDb): CrudAdapter<Row> {
  const store = db.table(model.tableName);
  const scope: AdapterScope = { tx: null };
  const applyFilters = (rows: Row[], filters: FilterCondition[]): Row[] =>
    filters.reduce(
      (acc, f) =>
        acc.filter((r) =>
          f.operator === 'predicate'
            ? matchesPredicate(r, f.value)
            : matchFilter(r[f.field], f.operator, f.value),
        ),
      rows,
    );
  return bindAdapter({
    capabilities: new Set(['transactions']),
    async requestScope<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      return fn(scope);
    },
    async transaction<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      return fn(scope);
    },
    async create(input: Partial<Row>): Promise<Row> {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup: Lookup, _opts: ReadOptions): Promise<Row | null> {
      return store.get(lookup.value) ?? null;
    },
    async update(lookup: Lookup, patch: Partial<Row>): Promise<Row | null> {
      const existing = store.get(lookup.value);
      if (existing === undefined) return null;
      const updated = { ...existing, ...patch };
      store.set(lookup.value, updated);
      return updated;
    },
    async delete(lookup: Lookup, _opts: DeleteOptions): Promise<Row | null> {
      const existing = store.get(lookup.value);
      if (existing === undefined) return null;
      store.delete(lookup.value);
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = applyFilters([...store.values()], query.filters);
      const page = query.options.page ?? 1;
      const perPage = query.options.per_page ?? 20;
      const total = rows.length;
      rows = rows.slice((page - 1) * perPage, page * perPage);
      return {
        result: rows,
        result_info: {
          page,
          per_page: perPage,
          total_count: total,
          total_pages: Math.max(1, Math.ceil(total / perPage)),
          has_next_page: page * perPage < total,
          has_prev_page: page > 1,
        },
      };
    },
  });
}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

async function makeApp(
  studio: Partial<StudioModuleOptions> = {},
  tt: TimeTravelPanelOptions | 'off' = {},
): Promise<App> {
  const db = new MemoryDb();
  db.table('widgets').set('w1', { id: 'w1', name: 'alpha', createdAt: 1, updatedAt: 1 });
  db.table('widgets').set('w2', { id: 'w2', name: 'beta', createdAt: 2, updatedAt: 2 });
  const adapter = memoryAdapter(widgetModel, db);

  @Controller('/widgets')
  class WidgetsController {}
  Crud({ ...{ model: widgetModel, adapter }, only: [] })(WidgetsController);

  const plugins = tt === 'off' ? [crudPanel()] : [crudPanel(), timeTravelPanel(tt)];

  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, ...studio, plugins })],
    controllers: [WidgetsController],
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
  const d = res.error.details as StudioConfirmChallenge;
  expect(typeof d.confirmToken).toBe('string');
  return d;
}

describe('timeTravel wiring — unbound port', () => {
  it('capabilities.timeTravel is null and ops 409 TIMETRAVEL_UNAVAILABLE', async () => {
    const app = await makeApp({}, 'off');
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.timeTravel).toBeNull();
    expect(caps.features.timeTravel).toBe(false);

    const res = await rpc(app, 'timeTravel.currentMark', {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(409);
    expect(res.error.code).toBe('TIMETRAVEL_UNAVAILABLE');
  });
});

describe('timeTravel wiring — bound port', () => {
  it('capabilities.timeTravel reflects the portable adapter shape', async () => {
    const app = await makeApp();
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.timeTravel).toBe(true);
    expect(caps.timeTravel).toMatchObject({ granularity: 'snapshot', portableExport: true });

    const ttCaps = ok(await rpc(app, 'timeTravel.capabilities', {}));
    expect(ttCaps.granularity).toBe('snapshot');
  });
});

describe('timeTravel ops — snapshot + restore round-trip through dispatch', () => {
  it('createSnapshot → mutate → preview → armRestore restores rows', async () => {
    const app = await makeApp({ editable: { data: true, timeTravel: true } });

    const mark = ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    expect(mark.tables).toEqual(['widget']);

    // Mutate a row through the data write op.
    ok(await rpc(app, 'data.writeRow', { model: 'widget', id: 'w1', patch: { name: 'CHANGED' } }));
    expect(ok(await rpc(app, 'data.readRow', { model: 'widget', id: 'w1' }))!.name).toBe('CHANGED');

    const preview = ok(await rpc(app, 'timeTravel.preview', { target: { bookmark: mark.id } }));
    expect(preview.schemaCompatible).toBe(true);

    const restore = ok(
      await rpc(app, 'timeTravel.armRestore', {
        bookmark: mark.id,
        confirmToken: preview.confirmToken,
      }),
    );
    expect(restore.applied).toBe(true);

    // w1 restored to its snapshot value.
    expect(ok(await rpc(app, 'data.readRow', { model: 'widget', id: 'w1' }))!.name).toBe('alpha');
  });

  it('armRestore rides the single-use 428 confirm challenge', async () => {
    const app = await makeApp({ editable: { data: true, timeTravel: true } });
    const mark = ok(await rpc(app, 'timeTravel.createSnapshot', {}));

    // No token → 428 with a human summary.
    const first = await rpc(app, 'timeTravel.armRestore', { bookmark: mark.id, confirmToken: '' });
    const { confirmToken, summary } = challenge(first);
    expect(summary.toLowerCase()).toContain('restore');

    // Re-send with the token → runs.
    ok(await rpc(app, 'timeTravel.armRestore', { bookmark: mark.id, confirmToken }));

    // Replaying the SAME token → a fresh challenge (single-use).
    const replay = await rpc(app, 'timeTravel.armRestore', { bookmark: mark.id, confirmToken });
    const second = challenge(replay);
    expect(second.confirmToken).not.toBe(confirmToken);
  });

  it('armRestore is gated by timeTravelRestore (403 when the gate is closed)', async () => {
    const app = await makeApp({ editable: { data: true } }); // timeTravel gate closed
    const mark = ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    const res = await rpc(app, 'timeTravel.armRestore', { bookmark: mark.id, confirmToken: '' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('STUDIO_OP_FORBIDDEN');
  });

  it('prune runs through its own confirm challenge and audits the outcome', async () => {
    const app = await makeApp({ editable: { timeTravel: true } });
    ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    ok(await rpc(app, 'timeTravel.createSnapshot', {}));

    const first = await rpc(app, 'timeTravel.prune', {
      retention: { keepLast: 1 },
      confirmToken: '',
    });
    const { confirmToken } = challenge(first);
    const pruned = ok(
      await rpc(app, 'timeTravel.prune', { retention: { keepLast: 1 }, confirmToken }),
    );
    expect(pruned.pruned).toBe(2);

    const marks = ok(await rpc(app, 'timeTravel.listMarks', {}));
    expect(marks.marks.length).toBe(1);

    const audit = ok(await rpc(app, 'audit.tail', {})).find(
      (e) => e.op === 'timeTravel.prune' && e.status === 200,
    );
    expect(audit?.detail?.extra?.pruned).toBe(2);
  });
});

describe('timeTravel ops — audit-backed CDC via timeTravelPanel', () => {
  it('binds an AuditStoreChangeSource and reports snapshot+cdc', async () => {
    const auditStore = new MemoryAuditStore();
    const app = await makeApp(
      { editable: { timeTravel: true } },
      { changeSource: new AuditStoreChangeSource(auditStore) },
    );
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.timeTravel?.granularity).toBe('snapshot+cdc');
  });
});

// ===========================================================================
// A bound TIME_TRAVEL_PORT that is MISCONFIGURED (capabilities() throws) — the
// same failure class as a port bound without a STUDIO_MODEL_SOURCE.
// ===========================================================================

class BrokenTimeTravelPort implements TimeTravelPort {
  readonly id = 'broken';
  capabilities(): TimeTravelCapabilities {
    throw new Error('misconfigured time-travel port (no STUDIO_MODEL_SOURCE bound)');
  }
  getCurrentMark(): Promise<TimeTravelMark> {
    return Promise.reject(new Error('misconfigured'));
  }
  preview(): Promise<RestorePreview> {
    return Promise.reject(new Error('misconfigured'));
  }
  armRestore(): Promise<RestoreOutcome> {
    return Promise.reject(new Error('misconfigured'));
  }
}

async function brokenPortApp(): Promise<App> {
  @Module({
    providers: [defineProvider(TIME_TRAVEL_PORT, { useValue: new BrokenTimeTravelPort() })],
    exports: [TIME_TRAVEL_PORT],
  })
  class BrokenTimeTravelModule {}

  @Module({ imports: [StudioModule.forRoot({ token: TOKEN }), BrokenTimeTravelModule] })
  class BrokenApp {}
  return VelaFactory.create(BrokenApp);
}

describe('timeTravel wiring — bound-but-broken port', () => {
  it('studio.capabilities degrades timeTravel to null (200, not a 500) when the port throws', async () => {
    const app = await brokenPortApp();
    const res = await rpc(app, 'studio.capabilities');
    // The op must NOT 500: a single misconfigured port cannot black out every panel.
    expect(res.ok).toBe(true);
    expect(ok(res).timeTravel).toBeNull();
  });
});

describe('timeTravel ops — CDC through preview→arm (dispatch)', () => {
  it('preview(time) mints a token that arms a CDC replay up to that time', async () => {
    const auditStore = new MemoryAuditStore();
    const app = await makeApp(
      { editable: { data: true, timeTravel: true } },
      { changeSource: new AuditStoreChangeSource(auditStore) },
    );

    // Baseline snapshot: widgets w1=alpha, w2=beta at t0.
    const base = ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    const t0 = base.time!;

    // A change COMMITTED after the snapshot (recorded in the audit log): w1 renamed.
    await auditStore.log({
      id: 'cdc1',
      timestamp: new Date(t0 + 5),
      action: 'update',
      tableName: 'widgets',
      recordId: 'w1',
      previousRecord: { id: 'w1', name: 'alpha' },
      record: { id: 'w1', name: 'alpha-cdc' },
    });
    const targetTime = t0 + 10;

    // Diverge live state so the restore+replay must overwrite it.
    ok(await rpc(app, 'data.writeRow', { model: 'widget', id: 'w1', patch: { name: 'GARBAGE' } }));

    // Preview a restore to the mid-window time. On a CDC adapter the token now
    // carries { bookmark, time } (not just the collapsed bookmark).
    const preview = ok(await rpc(app, 'timeTravel.preview', { target: { time: targetTime } }));
    expect(preview.target.id).toBe(base.id);

    // Arm with the previewed token: reload the base snapshot, then replay CDC up
    // to targetTime — reaching the exact mid-window state, not the snapshot edge.
    const restore = ok(
      await rpc(app, 'timeTravel.armRestore', {
        bookmark: preview.target.id,
        time: targetTime,
        confirmToken: preview.confirmToken,
      }),
    );
    expect(restore.applied).toBe(true);

    // w1 reflects the CDC-replayed value — NOT the snapshot's 'alpha', NOT 'GARBAGE'.
    const w1 = ok(await rpc(app, 'data.readRow', { model: 'widget', id: 'w1' }));
    expect(w1!.name).toBe('alpha-cdc');
  });
});

describe('timeTravel ops — undo + markForTime through dispatch', () => {
  it('undo runs through its own 428 challenge, returning data to the undo mark', async () => {
    const app = await makeApp({ editable: { data: true, timeTravel: true } });
    const base = ok(await rpc(app, 'timeTravel.createSnapshot', {}));

    // Diverge: rename w1.
    ok(await rpc(app, 'data.writeRow', { model: 'widget', id: 'w1', patch: { name: 'DIVERGED' } }));

    // Restore to base (confirm via challenge) → w1 back to 'alpha'; capture undoMark.
    const armCh = challenge(
      await rpc(app, 'timeTravel.armRestore', { bookmark: base.id, confirmToken: '' }),
    );
    const restore = ok(
      await rpc(app, 'timeTravel.armRestore', {
        bookmark: base.id,
        confirmToken: armCh.confirmToken,
      }),
    );
    expect(ok(await rpc(app, 'data.readRow', { model: 'widget', id: 'w1' }))!.name).toBe('alpha');
    const undoMarkId = restore.undoMark!.id;

    // Undo via dispatch — its OWN 428 challenge — restores the diverged state.
    const undoCh = challenge(
      await rpc(app, 'timeTravel.undo', { undoMark: undoMarkId, confirmToken: '' }),
    );
    const undone = ok(
      await rpc(app, 'timeTravel.undo', {
        undoMark: undoMarkId,
        confirmToken: undoCh.confirmToken,
      }),
    );
    expect(undone.applied).toBe(true);
    expect(ok(await rpc(app, 'data.readRow', { model: 'widget', id: 'w1' }))!.name).toBe(
      'DIVERGED',
    );
  });

  it('markForTime resolves the base snapshot for a time (and null before any)', async () => {
    const app = await makeApp({ editable: { timeTravel: true } });
    const base = ok(await rpc(app, 'timeTravel.createSnapshot', {}));
    const t0 = base.time!;

    const at = ok(await rpc(app, 'timeTravel.markForTime', { time: t0 + 1000 }));
    expect(at?.id).toBe(base.id);

    const before = ok(await rpc(app, 'timeTravel.markForTime', { time: t0 - 1000 }));
    expect(before).toBeNull();
  });
});

it('rejects named-database CDC before any restore writes but keeps explicit snapshots usable', async () => {
  const source = userSource();
  const listModels = source.listModels.bind(source);
  source.listModels = () => listModels().map((model) => ({ ...model, database: 'alpha' }));
  const adapter = makeAdapter(source, { changeSource: new FakeChangeSource([]), now: () => 1000 });
  expect(adapter.capabilities().granularity).toBe('snapshot');
  const mark = await adapter.createSnapshot({});
  source.models.get('user')!.rows.set('u1', { id: 'u1', email: 'after-snapshot' });
  await expect(adapter.preview({ bookmark: mark.id, time: 2000 })).rejects.toThrow(
    'CDC replay for named databases',
  );
  await expect(
    adapter.armRestore({ bookmark: mark.id, time: 2000, confirmToken: 'test' }),
  ).rejects.toThrow('CDC replay for named databases');
  expect(source.models.get('user')!.rows.get('u1')?.email).toBe('after-snapshot');
  expect((await adapter.listMarks()).marks).toHaveLength(1);
  await adapter.armRestore({ bookmark: mark.id, confirmToken: 'test' });
  expect(source.models.get('user')!.rows.get('u1')?.email).toBe('ann@x.io');
});
