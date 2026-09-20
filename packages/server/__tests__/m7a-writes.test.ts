import { bindAdapter } from '@velajs/crud/adapter';
import { describe, expect, it } from 'vitest';
import { Controller, METADATA_KEYS, Module, VelaFactory, defineMetadata } from '@velajs/vela';
import type { CrudConfig } from '@velajs/crud';
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
import { MAX_GENERATE_ROWS, StudioModule } from '../src';
import type { StudioConfirmChallenge, StudioModuleOptions } from '../src';
import { StudioCrudModule } from '../src/crud';
import type {
  AdminAuditEntry,
  AdminRpcResponse,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
} from '@velajs/studio-protocol';

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Hand-authored normalized crud models (mirrors defineModels output — zod
// resolves only inside @velajs/crud's peer scope, so the fixture stamps the same
// METADATA_KEYS.CRUD metadata over structural Zod stand-ins, exactly as M5).
// ---------------------------------------------------------------------------

interface FieldSpec {
  type: string;
  optional?: boolean;
  nullable?: boolean;
}

function zField(spec: FieldSpec): unknown {
  let node: { def: { type: string; innerType?: unknown } } = { def: { type: spec.type } };
  if (spec.nullable) node = { def: { type: 'nullable', innerType: node } };
  if (spec.optional) node = { def: { type: 'optional', innerType: node } };
  return node;
}

function zSchema(shape: Record<string, FieldSpec>): Model['schema'] {
  const built: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(shape)) built[name] = zField(spec);
  return { shape: built } as unknown as Model['schema'];
}

const userModel: Model = {
  name: 'user',
  namePlural: 'users',
  tableName: 'users',
  schema: zSchema({
    id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    active: { type: 'boolean', optional: true },
    createdAt: { type: 'number', optional: true },
    updatedAt: { type: 'number', optional: true },
  }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  unique: [['email']],
  versioning: false,
  audit: false,
  relations: {
    posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } satisfies RelationConfig,
  },
};

const postModel: Model = {
  name: 'post',
  namePlural: 'posts',
  tableName: 'posts',
  schema: zSchema({
    id: { type: 'string' },
    title: { type: 'string' },
    authorId: { type: 'string' },
    views: { type: 'number', optional: true },
    deletedAt: { type: 'number', nullable: true, optional: true },
    createdAt: { type: 'number', optional: true },
    updatedAt: { type: 'number', optional: true },
  }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  softDeleteField: 'deletedAt',
  versioning: false,
  audit: false,
  relations: {
    author: { type: 'belongsTo', target: 'users', foreignKey: 'authorId' } satisfies RelationConfig,
  },
};

// --- a tiny multi-table in-memory database + write-capable adapter ----------

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
  seed(name: string, rows: Row[]): void {
    const t = this.table(name);
    for (const row of rows) t.set(String(row.id), { ...row });
  }
}

const str = (v: unknown): string => (v == null ? '' : String(v));

function matchFilter(value: unknown, operator: FilterOperator, needle: unknown): boolean {
  switch (operator) {
    case 'eq':
      return str(value) === str(needle);
    case 'ne':
      return str(value) !== str(needle);
    default:
      return true;
  }
}

function memoryAdapter(model: Model, db: MemoryDb): CrudAdapter<Row> {
  const store = db.table(model.tableName);
  const sd = model.softDeleteField;
  const scope: AdapterScope = { tx: null };

  const applyFilters = (rows: Row[], filters: FilterCondition[]): Row[] =>
    filters.reduce(
      (acc, f) => acc.filter((r) => matchFilter(r[f.field], f.operator, f.value)),
      rows,
    );

  const adapter: CrudAdapter<Row> = bindAdapter({
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
    async readOne(lookup: Lookup, opts: ReadOptions): Promise<Row | null> {
      const row = store.get(lookup.value);
      if (row === undefined) return null;
      if (opts.withDeleted !== true && sd !== undefined && row[sd] != null) return null;
      return row;
    },
    async update(lookup: Lookup, patch: Partial<Row>): Promise<Row | null> {
      const existing = store.get(lookup.value);
      if (existing === undefined) return null;
      const updated = { ...existing, ...patch };
      store.set(lookup.value, updated);
      return updated;
    },
    async delete(lookup: Lookup, opts: DeleteOptions): Promise<Row | null> {
      const existing = store.get(lookup.value);
      if (existing === undefined) return null;
      if (opts.softDeleteField !== undefined) {
        const stamped = { ...existing, [opts.softDeleteField]: Date.now() };
        store.set(lookup.value, stamped);
        return stamped;
      }
      store.delete(lookup.value);
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = [...store.values()];
      if (sd !== undefined && query.options.withDeleted !== true) {
        rows = rows.filter((r) => r[sd] == null);
      }
      rows = applyFilters(rows, query.filters);
      const page = query.options.page ?? 1;
      const perPage = query.options.per_page ?? 20;
      const total = rows.length;
      const slice = rows.slice((page - 1) * perPage, page * perPage);
      return {
        result: slice,
        result_info: {
          page,
          per_page: perPage,
          total_count: total,
          total_pages: Math.ceil(total / perPage),
          has_next_page: page * perPage < total,
          has_prev_page: page > 1,
        },
      };
    },
  });
  return adapter;
}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

async function makeApp(studio: Partial<StudioModuleOptions> = {}): Promise<App> {
  const db = new MemoryDb();
  db.seed('users', [
    { id: 'u1', email: 'ann@x.io', role: 'admin', createdAt: 1, updatedAt: 1 },
    { id: 'u2', email: 'bob@x.io', role: 'member', createdAt: 2, updatedAt: 2 },
  ]);
  db.seed('posts', [
    { id: 'p1', title: 'Hello', authorId: 'u1', deletedAt: null, createdAt: 1, updatedAt: 1 },
    { id: 'p2', title: 'World', authorId: 'u2', deletedAt: null, createdAt: 2, updatedAt: 2 },
    { id: 'p3', title: 'Draft', authorId: 'u1', deletedAt: null, createdAt: 3, updatedAt: 3 },
  ]);

  const usersAdapter = memoryAdapter(userModel, db);
  const postsAdapter = memoryAdapter(postModel, db);

  @Controller('/users')
  class UsersController {}
  defineMetadata(
    METADATA_KEYS.CRUD,
    { model: userModel, adapter: usersAdapter } satisfies CrudConfig,
    UsersController,
  );

  @Controller('/posts')
  class PostsController {}
  defineMetadata(
    METADATA_KEYS.CRUD,
    { model: postModel, adapter: postsAdapter } satisfies CrudConfig,
    PostsController,
  );

  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, ...studio }), StudioCrudModule.forRoot({})],
    controllers: [UsersController, PostsController],
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

/** Assert a 428 confirm challenge and return its typed details. */
function challenge<T>(res: AdminRpcResponse<T>): StudioConfirmChallenge {
  if (res.ok) throw new Error(`expected a 428 challenge, got ${JSON.stringify(res)}`);
  expect(res.status).toBe(428);
  expect(res.error.code).toBe('STUDIO_CONFIRM_REQUIRED');
  const d = res.error.details;
  if (
    typeof d !== 'object' ||
    d === null ||
    typeof (d as Record<string, unknown>).confirmToken !== 'string' ||
    typeof (d as Record<string, unknown>).summary !== 'string'
  ) {
    throw new Error(`missing challenge details: ${JSON.stringify(res.error.details)}`);
  }
  return d as StudioConfirmChallenge;
}

async function auditRowFor(app: App, op: StudioOp): Promise<AdminAuditEntry> {
  const tail = ok(await rpc(app, 'audit.tail', {}));
  const row = tail.find((e) => e.op === op);
  if (row === undefined) throw new Error(`no audit row for ${op}`);
  return row;
}

/** The `detail.extra` bag of an audit row (asserted present). */
function extra(audit: AdminAuditEntry): Record<string, unknown> {
  const bag = audit.detail?.extra;
  if (bag === undefined) throw new Error(`audit row for ${audit.op} has no detail.extra`);
  return bag;
}

// ---------------------------------------------------------------------------

describe('data.writeRow', () => {
  it('creates a row (id absent): stamps id + timestamps, audits before:null + after', async () => {
    const app = await makeApp({ editable: { data: true } });
    const created = ok(
      await rpc(app, 'data.writeRow', {
        model: 'user',
        patch: { email: 'cat@x.io', role: 'member' },
      }),
    );
    expect(created.email).toBe('cat@x.io');
    expect(typeof created.id).toBe('string'); // uuid stamped
    expect(created.createdAt).toBeTypeOf('number'); // timestamp stamped
    expect(created.updatedAt).toBeTypeOf('number');

    const audit = await auditRowFor(app, 'data.writeRow');
    expect(audit.mode).toBe('write');
    expect(audit.status).toBe(200);
    expect(extra(audit).before).toBeNull();
    expect((extra(audit).after as Row).email).toBe('cat@x.io');
  });

  it('updates a row (id present): patches fields, audits before + after images', async () => {
    const app = await makeApp({ editable: { data: true } });
    const updated = ok(
      await rpc(app, 'data.writeRow', { model: 'user', id: 'u1', patch: { role: 'owner' } }),
    );
    expect(updated.id).toBe('u1');
    expect(updated.role).toBe('owner');
    expect(updated.email).toBe('ann@x.io'); // untouched

    const audit = await auditRowFor(app, 'data.writeRow');
    expect((extra(audit).before as Row).role).toBe('admin');
    expect((extra(audit).after as Row).role).toBe('owner');
  });

  it('404s an unknown model and an unknown row', async () => {
    const app = await makeApp({ editable: { data: true } });

    const badModel = await rpc(app, 'data.writeRow', { model: 'ghost', patch: {} });
    expect(badModel.ok).toBe(false);
    if (badModel.ok) throw new Error('expected error');
    expect(badModel.status).toBe(404);
    expect(badModel.error.code).toBe('STUDIO_UNKNOWN_MODEL');

    const badRow = await rpc(app, 'data.writeRow', {
      model: 'user',
      id: 'nope',
      patch: { role: 'x' },
    });
    expect(badRow.ok).toBe(false);
    if (badRow.ok) throw new Error('expected error');
    expect(badRow.status).toBe(404);
  });

  it('409s a uniqueness conflict (duplicate email on create)', async () => {
    const app = await makeApp({ editable: { data: true } });
    const res = await rpc(app, 'data.writeRow', {
      model: 'user',
      patch: { email: 'ann@x.io', role: 'member' }, // ann already exists
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(409);
    expect(res.error.code).toBe('conflict');
  });

  it('403s DATA_EDIT_DISABLED when data editing is off (read-only Studio)', async () => {
    const app = await makeApp(); // editable.data defaults false
    const res = await rpc(app, 'data.writeRow', { model: 'user', patch: { email: 'z@x.io' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('DATA_EDIT_DISABLED');
  });
});

describe('data.deleteRows', () => {
  it('409s a soft delete on a model without a soft-delete column (with a hint)', async () => {
    const app = await makeApp({ editable: { data: true } });
    // user has no softDeleteField. mode soft -> 409 + hint. Needs a valid confirm
    // first, so run the challenge then re-send.
    const first = await rpc(app, 'data.deleteRows', {
      model: 'user',
      ids: ['u1'],
      mode: 'soft',
      confirmToken: '',
    });
    const { confirmToken } = challenge(first);
    const res = await rpc(app, 'data.deleteRows', {
      model: 'user',
      ids: ['u1'],
      mode: 'soft',
      confirmToken,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(409);
    expect(res.error.code).toBe('conflict');
    expect(res.error.hint).toBeDefined();
  });

  it('runs a HARD delete end-to-end through the 428 challenge, single-use', async () => {
    const app = await makeApp({ editable: { data: true } });

    // (1) No token -> 428 challenge with a fresh token + human summary.
    const first = await rpc(app, 'data.deleteRows', {
      model: 'post',
      ids: ['p1', 'p2'],
      mode: 'hard',
      confirmToken: '',
    });
    const { confirmToken, summary, expiresAt } = challenge(first);
    expect(confirmToken.length).toBeGreaterThan(0);
    expect(summary).toBe('hard-delete 2 rows from post');
    expect(expiresAt).toBeGreaterThan(Date.now());

    // (2) Re-send identical args + the token -> the delete runs.
    const done = ok(
      await rpc(app, 'data.deleteRows', {
        model: 'post',
        ids: ['p1', 'p2'],
        mode: 'hard',
        confirmToken,
      }),
    );
    expect(done.deleted).toBe(2);

    // Gone for good.
    const gone = ok(await rpc(app, 'data.readRow', { model: 'post', id: 'p1' }));
    expect(gone).toBeNull();

    // (3) Replaying the SAME token fails (single-use) -> a fresh challenge.
    const replay = await rpc(app, 'data.deleteRows', {
      model: 'post',
      ids: ['p1', 'p2'],
      mode: 'hard',
      confirmToken,
    });
    const second = challenge(replay);
    expect(second.confirmToken).not.toBe(confirmToken);

    // (4) The fresh token completes the op (deleting nothing now — already gone).
    const again = ok(
      await rpc(app, 'data.deleteRows', {
        model: 'post',
        ids: ['p1', 'p2'],
        mode: 'hard',
        confirmToken: second.confirmToken,
      }),
    );
    expect(again.deleted).toBe(0);

    // Audit carries the before-images of the first (successful) delete.
    const tail = ok(await rpc(app, 'audit.tail', {}));
    const okDelete = tail.find(
      (e) => e.op === 'data.deleteRows' && e.status === 200 && e.detail?.extra?.deleted === 2,
    );
    if (okDelete === undefined) throw new Error('no successful deleteRows audit row');
    expect((extra(okDelete).before as Row[]).length).toBe(2);
  });

  it('soft-deletes (mode soft) on a soft-delete model through the challenge', async () => {
    const app = await makeApp({ editable: { data: true } });
    const first = await rpc(app, 'data.deleteRows', {
      model: 'post',
      ids: ['p3'],
      mode: 'soft',
      confirmToken: '',
    });
    const { confirmToken } = challenge(first);
    const done = ok(
      await rpc(app, 'data.deleteRows', { model: 'post', ids: ['p3'], mode: 'soft', confirmToken }),
    );
    expect(done.deleted).toBe(1);

    // The tombstoned row is hidden from a live read but visible withDeleted.
    const live = ok(await rpc(app, 'data.listRows', { model: 'post' }));
    expect(live.rows.some((r) => r.id === 'p3')).toBe(false);
    const all = ok(await rpc(app, 'data.listRows', { model: 'post', withDeleted: true }));
    expect(all.rows.some((r) => r.id === 'p3')).toBe(true);
  });
});

describe('data.clearTable', () => {
  it('challenges then wipes the whole table, returning { deleted }', async () => {
    const app = await makeApp({ editable: { data: true } });
    const first = await rpc(app, 'data.clearTable', { model: 'post', confirmToken: '' });
    const { confirmToken, summary } = challenge(first);
    expect(summary).toBe('clear ALL rows from post');

    const res = ok(await rpc(app, 'data.clearTable', { model: 'post', confirmToken }));
    expect(res.deleted).toBe(3);

    const remaining = ok(await rpc(app, 'data.listRows', { model: 'post', withDeleted: true }));
    expect(remaining.rows).toEqual([]);

    // Audit records the count, not per-row images.
    const audit = await auditRowFor(app, 'data.clearTable');
    expect(audit.detail?.extra?.deleted).toBe(3);
    expect(audit.detail?.extra?.before).toBeUndefined();
  });
});

describe('data.generateRows', () => {
  it('inserts synthetic rows with valid foreign keys', async () => {
    const app = await makeApp({ editable: { data: true } });
    const res = ok(await rpc(app, 'data.generateRows', { model: 'post', count: 4 }));
    expect(res.inserted).toBe(4);

    const all = ok(await rpc(app, 'data.listRows', { model: 'post' }));
    // 3 seeded + 4 generated.
    expect(all.info.total_count).toBe(7);

    const generated = all.rows.filter((r) => !['p1', 'p2', 'p3'].includes(String(r.id)));
    expect(generated.length).toBe(4);
    const userIds = new Set(['u1', 'u2']);
    for (const row of generated) {
      // FK validity: every generated authorId references a real user.
      expect(userIds.has(String(row.authorId))).toBe(true);
      // Deterministic synthetic title `<column>-<n>`.
      expect(String(row.title)).toMatch(/^title-\d+$/);
      expect(typeof row.id).toBe('string');
    }
  });

  it('is gated by dataEditable (403 when off)', async () => {
    const app = await makeApp();
    const res = await rpc(app, 'data.generateRows', { model: 'post', count: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('DATA_EDIT_DISABLED');
  });

  it('accepts a count AT the cap (MAX_GENERATE_ROWS)', async () => {
    const app = await makeApp({ editable: { data: true } });
    const res = ok(
      await rpc(app, 'data.generateRows', { model: 'post', count: MAX_GENERATE_ROWS }),
    );
    expect(res.inserted).toBe(MAX_GENERATE_ROWS);
  });

  it('rejects a count OVER the cap with a 400 + hint naming the cap', async () => {
    const app = await makeApp({ editable: { data: true } });
    const res = await rpc(app, 'data.generateRows', {
      model: 'post',
      count: MAX_GENERATE_ROWS + 1,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('bad_request');
    expect(res.error.hint).toContain(String(MAX_GENERATE_ROWS));

    // Nothing was inserted — the 3 seeded posts stand.
    const all = ok(await rpc(app, 'data.listRows', { model: 'post' }));
    expect(all.info.total_count).toBe(3);
  });
});

describe('runAsIdentity seam', () => {
  it('stamps the configured identity subject on write audit when the identity gate is open', async () => {
    const app = await makeApp({
      editable: { data: true, identity: true },
      runAsIdentity: { userId: 'svc-migrator' },
    });
    ok(await rpc(app, 'data.writeRow', { model: 'user', patch: { email: 'id@x.io' } }));
    const audit = await auditRowFor(app, 'data.writeRow');
    expect(audit.detail?.extra?.runAsIdentity).toBe('svc-migrator');
  });

  it('does NOT impersonate when the identity gate is closed', async () => {
    const app = await makeApp({
      editable: { data: true }, // identity gate closed
      runAsIdentity: { userId: 'svc-migrator' },
    });
    ok(await rpc(app, 'data.writeRow', { model: 'user', patch: { email: 'id2@x.io' } }));
    const audit = await auditRowFor(app, 'data.writeRow');
    expect(audit.detail?.extra?.runAsIdentity).toBeUndefined();
  });
});

describe('capabilities', () => {
  it('reflects writes.dataEditable from the editable config', async () => {
    const on = await makeApp({ editable: { data: true } });
    expect(ok(await rpc(on, 'studio.capabilities')).writes.dataEditable).toBe(true);

    const off = await makeApp();
    expect(ok(await rpc(off, 'studio.capabilities')).writes.dataEditable).toBe(false);
  });
});
