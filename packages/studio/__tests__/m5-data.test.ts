import { z } from 'zod';
import { matchesPredicate } from '@velajs/crud/query';
import { bindAdapter } from '@velajs/crud/adapter';
import { describe, expect, it, vi } from 'vitest';
import { Injectable, defineProvider, Controller, Module, VelaFactory } from '@velajs/vela';
import {
  Container,
  DiscoveryService,
  METADATA_KEYS,
  defineMetadata,
} from '@velajs/vela/module-kit';
import {
  CRUD_DATABASES,
  CRUD_DEFAULT_ADAPTER,
  Crud,
  createCrudDatabaseRegistry,
  defineCrudDatabase,
} from '@velajs/crud';
import type { CrudConfig } from '@velajs/crud';
import type { Model, RelationConfig } from '@velajs/crud/model';
import type {
  AdapterCapability,
  AdapterScope,
  AggregateResult,
  AggregateSpec,
  CrudAdapter,
  DeleteOptions,
  FilterCondition,
  FilterOperator,
  ListQuery,
  Lookup,
  Page,
  ReadOptions,
  SearchHit,
  SearchQuery,
} from '@velajs/crud/adapter';
import { StudioModule } from '../src';
import { STUDIO_DATA_OPTIONS } from '../src';
import type { StudioDataOptions, StudioModuleOptions } from '../src';
import { CrudStudioModelSource, crudPanel } from '../src/crud';
import { STUDIO_MODEL_SOURCE } from '../src/data/model-source.port';
import type {
  AdminRpcResponse,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioOp,
  StudioOpReq,
  StudioOpRes,
} from '@velajs/studio-protocol';

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Normalized crud models, hand-authored to mirror `defineModels` output.
//
// The crud model authoring surface (`defineModels`/`@Crud`) needs `zod`, which
// resolves only inside `@velajs/crud`'s own peer scope (adding it to this
// package is out of the allowed manifest change). So the fixture stamps the
// SAME `METADATA_KEYS.CRUD` metadata `@Crud` stamps, over hand-built normalized
// `Model`s + a real `CrudAdapter` — exercising the actual `CrudStudioModelSource`
// discovery + adapter mapping. Schemas are minimal Zod-shaped stand-ins that
// carry exactly the `def.type` structure the column derivation introspects.
// ---------------------------------------------------------------------------

interface FieldSpec {
  type: string;
  optional?: boolean;
  nullable?: boolean;
}

/** A Zod-v4-shaped field node (`def.type` + wrapper `innerType`). */
function zField(spec: FieldSpec): unknown {
  let node: { def: { type: string; innerType?: unknown } } = { def: { type: spec.type } };
  if (spec.nullable) node = { def: { type: 'nullable', innerType: node } };
  if (spec.optional) node = { def: { type: 'optional', innerType: node } };
  return node;
}

/** A Zod-object-shaped schema stand-in (only `.shape` is read by the source). */
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
    // Composite-unique members (tenantId, slug) — plain columns, NOT the model's
    // tenantField, so they exercise unique derivation without touching flags.
    tenantId: { type: 'string' },
    slug: { type: 'string' },
    createdAt: { type: 'number', optional: true },
    updatedAt: { type: 'number', optional: true },
  }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // A non-PK single unique (email) plus a composite unique (tenantId+slug): the
  // single projects `unique: true` on its column; composite members do not.
  unique: [['email'], ['tenantId', 'slug']],
  versioning: false,
  audit: false,
  relations: {
    // defineModels rewrites the target to the sibling tableName; the child's
    // soft-delete column is applied by the fixture adapter's cascade counter.
    posts: {
      type: 'hasMany',
      target: 'posts',
      foreignKey: 'authorId',
    } satisfies RelationConfig,
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
    status: { type: 'string' },
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

// --- a tiny multi-table in-memory "database" ------------------------------
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

const s = (v: unknown): string => (v == null ? '' : String(v));

function matchFilter(value: unknown, operator: FilterOperator, needle: unknown): boolean {
  switch (operator) {
    case 'eq':
      return s(value) === s(needle);
    case 'ne':
      return s(value) !== s(needle);
    case 'in':
      return Array.isArray(needle) && needle.map(s).includes(s(value));
    case 'nin':
      return Array.isArray(needle) && !needle.map(s).includes(s(value));
    case 'like':
      return s(value).includes(s(needle));
    case 'ilike':
      return s(value).toLowerCase().includes(s(needle).toLowerCase());
    case 'gt':
      return Number(value) > Number(needle);
    case 'gte':
      return Number(value) >= Number(needle);
    case 'lt':
      return Number(value) < Number(needle);
    case 'lte':
      return Number(value) <= Number(needle);
    case 'null':
      return needle === true || needle === 'true' ? value == null : value != null;
    case 'between':
      return (
        Array.isArray(needle) &&
        Number(value) >= Number(needle[0]) &&
        Number(value) <= Number(needle[1])
      );
    default:
      return true;
  }
}

/** A read-capable in-test memory adapter, table-bound via its model. */
function memoryAdapter(model: Model, db: MemoryDb, caps: AdapterCapability[]): CrudAdapter<Row> {
  const store = db.table(model.tableName);
  const sd = model.softDeleteField;
  const scope: AdapterScope = { tx: null };
  const capabilities = new Set<AdapterCapability>(caps);

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
  const visibleLive = (rows: Row[]): Row[] =>
    sd === undefined ? rows : rows.filter((r) => r[sd] == null);

  const adapter: CrudAdapter<Row> = bindAdapter({
    capabilities,
    async requestScope<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      return fn(scope);
    },
    async transaction<T>(fn: (s: AdapterScope) => Promise<T>): Promise<T> {
      if (!capabilities.has('transactions')) throw new Error('Callback transactions unavailable');
      return fn(scope);
    },
    async create(input: Partial<Row>): Promise<Row> {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup: Lookup, opts: ReadOptions): Promise<Row | null> {
      for (const row of store.values()) {
        if (String(row[lookup.field]) !== lookup.value) continue;
        let matched = true;
        for (const [k, v] of Object.entries(lookup.filters ?? {})) {
          if (String(row[k]) !== v) matched = false;
        }
        if (!matched) return null;
        if (opts.withDeleted !== true && sd !== undefined && row[sd] != null) return null;
        return row;
      }
      return null;
    },
    async update(lookup: Lookup, patch: Partial<Row>): Promise<Row | null> {
      const existing = await adapter.readOne(lookup, {}, scope);
      if (existing === null) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup: Lookup, opts: DeleteOptions): Promise<Row | null> {
      const existing = await adapter.readOne(lookup, {}, scope);
      if (existing === null) return null;
      if (opts.softDeleteField !== undefined) {
        const stamped = { ...existing, [opts.softDeleteField]: Date.now() };
        store.set(String(existing.id), stamped);
        return stamped;
      }
      store.delete(String(existing.id));
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = [...store.values()];
      if (sd !== undefined) {
        if (query.options.onlyDeleted) rows = rows.filter((r) => r[sd] != null);
        else if (query.options.withDeleted !== true) rows = rows.filter((r) => r[sd] == null);
      }
      rows = applyFilters(rows, query.filters);
      if (query.options.order_by !== undefined) {
        const field = query.options.order_by;
        const dir = query.options.order_by_direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -dir : dir));
      }
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

  if (capabilities.has('aggregate')) {
    adapter.aggregate = async (spec: AggregateSpec): Promise<AggregateResult> => {
      const field = spec.groupBy?.[0];
      if (field === undefined) return { values: { count: store.size } };
      const rows = applyFilters(visibleLive([...store.values()]), spec.filters);
      const counts = new Map<unknown, number>();
      for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      let groups = [...counts.entries()].map(([value, count]) => ({
        key: { [field]: value },
        values: { count },
      }));
      groups.sort((a, b) => b.values.count - a.values.count);
      const total = groups.length;
      if (spec.limit !== undefined) groups = groups.slice(0, spec.limit);
      return { groups, totalGroups: total };
    };
  }

  if (capabilities.has('nativeSearch')) {
    adapter.search = async (spec: SearchQuery): Promise<Array<SearchHit<Row>>> => {
      const term = spec.term.toLowerCase();
      const fields = spec.fields.map((f) => f.field);
      const rows = applyFilters(visibleLive([...store.values()]), spec.filters).filter((r) =>
        fields.some((f) =>
          String(r[f] ?? '')
            .toLowerCase()
            .includes(term),
        ),
      );
      const page = spec.options.page ?? 1;
      const per = spec.options.per_page ?? 20;
      return rows.slice((page - 1) * per, page * per).map((record) => ({ record, score: 1 }));
    };
  }

  if (capabilities.has('cascade')) {
    const countRelated = async (relation: string, parentKey: unknown): Promise<number> => {
      const rel = model.relations?.[relation];
      if (rel === undefined) return 0;
      const childStore = db.table(rel.target ?? '');
      let n = 0;
      for (const row of childStore.values()) {
        if (String(row[rel.foreignKey]) !== String(parentKey)) continue;
        // The fixture's soft-deletable child (posts) tombstones via `deletedAt`.
        if (row.deletedAt != null) continue;
        n++;
      }
      return n;
    };
    adapter.cascade = {
      countRelated,
      async deleteRelated(relation, parentKey) {
        return countRelated(relation, parentKey);
      },
      async nullifyRelated(relation, parentKey) {
        return countRelated(relation, parentKey);
      },
    };
  }

  return adapter;
}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

/** Build an app with two @Crud resources + Studio + the crud source binding. */
async function makeCrudApp(
  options: Partial<StudioModuleOptions> & StudioDataOptions = {},
): Promise<App> {
  const { managedModels, runAsIdentity, ...studio } = options;
  const crud = crudPanel({
    ...(managedModels === undefined ? {} : { managedModels }),
    ...(runAsIdentity === undefined ? {} : { runAsIdentity }),
  });
  const db = new MemoryDb();
  db.seed('users', [
    { id: 'u1', email: 'ann@x.io', role: 'admin', createdAt: 1 },
    { id: 'u2', email: 'bob@x.io', role: 'member', createdAt: 2 },
    { id: 'u3', email: 'cat@x.io', role: 'member', createdAt: 3 },
  ]);
  db.seed('posts', [
    {
      id: 'p1',
      title: 'Hello World',
      authorId: 'u1',
      status: 'published',
      deletedAt: null,
      createdAt: 1,
    },
    {
      id: 'p2',
      title: 'Draft note',
      authorId: 'u1',
      status: 'draft',
      deletedAt: null,
      createdAt: 2,
    },
    {
      id: 'p3',
      title: 'World tour',
      authorId: 'u2',
      status: 'published',
      deletedAt: null,
      createdAt: 3,
    },
    {
      id: 'p4',
      title: 'Tombstoned',
      authorId: 'u1',
      status: 'draft',
      deletedAt: 123,
      createdAt: 4,
    },
  ]);

  // users: aggregate (facets) + cascade (preview). posts: soft-delete + search.
  const usersAdapter = memoryAdapter(userModel, db, ['aggregate', 'cascade']);
  const postsAdapter = memoryAdapter(postModel, db, ['softDelete', 'nativeSearch']);

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
    { model: postModel, adapter: postsAdapter, searchFields: ['title'] } satisfies CrudConfig,
    PostsController,
  );

  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, ...studio, plugins: [crud] })],
    controllers: [UsersController, PostsController],
  })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

// A parent→child pair whose relation carries an explicit `cascade.onDelete`,
// used to prove cascadePreview surfaces the authored action (not just noAction).
const orgModel: Model = {
  name: 'org',
  namePlural: 'orgs',
  tableName: 'orgs',
  schema: zSchema({ id: { type: 'string' }, name: { type: 'string' } }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: false, updatedAt: false },
  versioning: false,
  audit: false,
  relations: {
    seats: {
      type: 'hasMany',
      target: 'seats',
      foreignKey: 'orgId',
      cascade: { onDelete: 'cascade' },
    } satisfies RelationConfig,
  },
};

const seatModel: Model = {
  name: 'seat',
  namePlural: 'seats',
  tableName: 'seats',
  schema: zSchema({ id: { type: 'string' }, orgId: { type: 'string' } }),
  primaryKeys: ['id'],
  id: 'uuid',
  timestamps: { createdAt: false, updatedAt: false },
  versioning: false,
  audit: false,
};

/** Build an app whose org→seats relation authors `cascade.onDelete: 'cascade'`. */
async function makeCascadeApp(): Promise<App> {
  const db = new MemoryDb();
  db.seed('orgs', [{ id: 'o1', name: 'Acme' }]);
  db.seed('seats', [
    { id: 's1', orgId: 'o1' },
    { id: 's2', orgId: 'o1' },
  ]);

  const orgsAdapter = memoryAdapter(orgModel, db, ['cascade']);
  const seatsAdapter = memoryAdapter(seatModel, db, []);

  @Controller('/orgs')
  class OrgsController {}
  defineMetadata(
    METADATA_KEYS.CRUD,
    { model: orgModel, adapter: orgsAdapter } satisfies CrudConfig,
    OrgsController,
  );

  @Controller('/seats')
  class SeatsController {}
  defineMetadata(
    METADATA_KEYS.CRUD,
    { model: seatModel, adapter: seatsAdapter } satisfies CrudConfig,
    SeatsController,
  );

  @Module({
    imports: [StudioModule.forRoot({ token: TOKEN, plugins: [crudPanel()] })],
    controllers: [OrgsController, SeatsController],
  })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

/** Build an app with Studio but NO crud source bound. */
async function makeBareApp(): Promise<App> {
  @Module({ imports: [StudioModule.forRoot({ token: TOKEN })] })
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

function ok<T>(res: AdminRpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return res.data;
}

describe('data.listModels', () => {
  it('lists both models with honest, adapter-derived capabilities', async () => {
    const app = await makeCrudApp();
    const models: StudioModelInfo[] = ok(await rpc(app, 'data.listModels'));
    const byName = new Map(models.map((m) => [m.name, m]));
    expect([...byName.keys()].toSorted()).toEqual(['post', 'user']);
    expect(byName.get('user')?.table).toBe('users');
    expect([...(byName.get('user')?.capabilities ?? [])].toSorted()).toEqual([
      'aggregate',
      'cascade',
    ]);
    expect([...(byName.get('post')?.capabilities ?? [])].toSorted()).toEqual([
      'nativeSearch',
      'softDelete',
    ]);
  });
});

describe('data.describeModel', () => {
  it('sources pk/fk/nullable/unique/managed columns, relations, flags, supports', async () => {
    const app = await makeCrudApp();
    const post: StudioModelDescriptor = ok(await rpc(app, 'data.describeModel', { model: 'post' }));

    expect(post.table).toBe('posts');
    expect(post.primaryKeys).toEqual(['id']);

    const col = (name: string) => post.columns.find((c) => c.name === name);
    expect(col('id')?.pk).toBe(true);
    expect(col('id')?.unique).toBe(true);
    expect(col('title')?.type).toBe('string');
    // FK column sourced from the belongsTo relation.
    expect(col('authorId')?.fk).toEqual({ table: 'users', relation: 'author' });
    // Managed columns: timestamps + soft-delete.
    expect(col('createdAt')?.managed).toBe(true);
    expect(col('deletedAt')?.managed).toBe(true);
    expect(col('deletedAt')?.nullable).toBe(true);
    expect(col('status')?.managed).toBe(false);

    // Relation + flags + capability supports.
    expect(post.relations).toEqual([
      { name: 'author', type: 'belongsTo', target: 'users', foreignKey: 'authorId' },
    ]);
    expect(post.flags.softDelete).toBe(true);
    expect(post.flags.multiTenant).toBe(false);
    expect(post.supports).toEqual({
      bulkWrites: false,
      facets: false,
      search: true,
      cascade: false,
    });

    const user: StudioModelDescriptor = ok(await rpc(app, 'data.describeModel', { model: 'user' }));
    expect(user.relations).toEqual([
      { name: 'posts', type: 'hasMany', target: 'posts', foreignKey: 'authorId' },
    ]);
    expect(user.supports).toEqual({
      bulkWrites: false,
      facets: true,
      search: false,
      cascade: true,
    });
  });

  it('derives unique per-column: single-column unique yes, composite members no, pk yes', async () => {
    const app = await makeCrudApp();
    const user: StudioModelDescriptor = ok(await rpc(app, 'data.describeModel', { model: 'user' }));
    const col = (name: string) => user.columns.find((c) => c.name === name);

    // A non-PK single-column unique (`unique: [['email']]`) projects on its column.
    expect(col('email')?.unique).toBe(true);
    expect(col('email')?.pk).toBe(false);
    // Composite-unique members (`[['tenantId','slug']]`) do NOT get `unique: true`.
    expect(col('tenantId')?.unique).toBe(false);
    expect(col('slug')?.unique).toBe(false);
    // The primary key is still reported unique.
    expect(col('id')?.pk).toBe(true);
    expect(col('id')?.unique).toBe(true);
  });

  it('unknown model -> STUDIO_UNKNOWN_MODEL (404)', async () => {
    const app = await makeCrudApp();
    const res = await rpc(app, 'data.describeModel', { model: 'ghost' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(404);
    expect(res.error.code).toBe('STUDIO_UNKNOWN_MODEL');
  });
});

describe('data.listRows', () => {
  it('reads and writes one row without transactions, and rejects bulk mutations before changing rows', async () => {
    const app = await makeCrudApp();
    const source = app.getContainer().resolve(STUDIO_MODEL_SOURCE);
    expect(source.describe('user').supports.bulkWrites).toBe(false);
    const before = await source.list('user', { model: 'user' });
    const created = await source.writeRow?.(
      'user',
      { model: 'user', patch: { email: 'new@x.io' } },
      {},
    );
    expect(created?.after.email).toBe('new@x.io');
    await expect(
      source.deleteRows?.(
        'user',
        { model: 'user', ids: ['u1'], mode: 'hard', confirmToken: '' },
        {},
      ),
    ).rejects.toThrow('requires an adapter with transactions');
    expect((await source.list('user', { model: 'user' })).rows).toHaveLength(
      before.rows.length + 1,
    );
    expect(await source.readOne('user', 'u1')).not.toBeNull();
  });
  it('applies eq/like/in filters, sort, and page/perPage with page info', async () => {
    const app = await makeCrudApp();

    const members = ok(
      await rpc(app, 'data.listRows', {
        model: 'user',
        filters: [{ field: 'role', operator: 'eq', value: 'member' }],
      }),
    );
    expect(members.rows.map((r) => r.id).toSorted()).toEqual(['u2', 'u3']);
    expect(members.info.total_count).toBe(2);

    const worlds = ok(
      await rpc(app, 'data.listRows', {
        model: 'post',
        filters: [{ field: 'title', operator: 'like', value: 'World' }],
        sort: { field: 'createdAt', order: 'asc' },
      }),
    );
    expect(worlds.rows.map((r) => r.id)).toEqual(['p1', 'p3']);

    const page1 = ok(
      await rpc(app, 'data.listRows', {
        model: 'post',
        filters: [{ field: 'status', operator: 'in', value: ['published', 'draft'] }],
        sort: { field: 'createdAt', order: 'asc' },
        page: 1,
        perPage: 2,
      }),
    );
    expect(page1.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(page1.info).toMatchObject({ page: 1, per_page: 2, total_count: 3, has_next_page: true });
  });

  it('hides soft-deleted rows by default and reveals them with withDeleted', async () => {
    const app = await makeCrudApp();
    const live = ok(await rpc(app, 'data.listRows', { model: 'post' }));
    expect(live.rows.some((r) => r.id === 'p4')).toBe(false);
    expect(live.info.total_count).toBe(3);

    const all = ok(await rpc(app, 'data.listRows', { model: 'post', withDeleted: true }));
    expect(all.rows.some((r) => r.id === 'p4')).toBe(true);
    expect(all.info.total_count).toBe(4);
  });

  it('runs an inline search on the native-search adapter', async () => {
    const app = await makeCrudApp();
    const hits = ok(await rpc(app, 'data.listRows', { model: 'post', search: 'draft' }));
    expect(hits.rows.map((r) => r.id)).toEqual(['p2']);
  });
});

describe('data.readRow', () => {
  it('returns the row when found, null when missing, 404 for an unknown model', async () => {
    const app = await makeCrudApp();

    const found = ok(await rpc(app, 'data.readRow', { model: 'user', id: 'u1' }));
    expect(found?.email).toBe('ann@x.io');

    const missing = ok(await rpc(app, 'data.readRow', { model: 'user', id: 'nope' }));
    expect(missing).toBeNull();

    const bad = await rpc(app, 'data.readRow', { model: 'ghost', id: 'u1' });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected error');
    expect(bad.status).toBe(404);
    expect(bad.error.code).toBe('STUDIO_UNKNOWN_MODEL');
  });
});

describe('data.facets', () => {
  it('returns value buckets with counts over an aggregate-capable adapter', async () => {
    const app = await makeCrudApp();
    const facets = ok(await rpc(app, 'data.facets', { model: 'user', field: 'role' }));
    const byValue = new Map(facets.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get('member')).toBe(2);
    expect(byValue.get('admin')).toBe(1);
  });

  it('reports FEATURE_UNCONFIGURED when the adapter lacks aggregate', async () => {
    const app = await makeCrudApp();
    const res = await rpc(app, 'data.facets', { model: 'post', field: 'status' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(404);
    expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
  });
});

describe('data.cascadePreview', () => {
  it('reports the relation impact for the FK pair', async () => {
    const app = await makeCrudApp();
    // Deleting u1 cascades to its LIVE posts (p1, p2; p4 is tombstoned).
    const preview = ok(await rpc(app, 'data.cascadePreview', { model: 'user', ids: ['u1'] }));
    expect(preview.relations).toEqual([
      { relation: 'posts', target: 'posts', action: 'noAction', affected: 2 },
    ]);
  });

  it('surfaces an explicit cascade.onDelete action authored on the relation', async () => {
    const app = await makeCascadeApp();
    const preview = ok(await rpc(app, 'data.cascadePreview', { model: 'org', ids: ['o1'] }));
    expect(preview.relations).toEqual([
      { relation: 'seats', target: 'seats', action: 'cascade', affected: 2 },
    ]);
  });

  it('omits a relation whose target model is excluded (no aggregate-count leak)', async () => {
    // With `post` excluded, user's only hasMany relation targets a hidden model:
    // it must be absent from the preview so its row count never leaks.
    const app = await makeCrudApp({ managedModels: { exclude: ['post'] } });
    const preview = ok(await rpc(app, 'data.cascadePreview', { model: 'user', ids: ['u1'] }));
    expect(preview.relations.some((r) => r.relation === 'posts')).toBe(false);
    expect(preview.relations).toEqual([]);
  });
});

describe('no-crud app', () => {
  it('reports the data feature false and FEATURE_UNCONFIGURED on data ops', async () => {
    const app = await makeBareApp();
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.data).toBe(false);

    const res = await rpc(app, 'data.listModels');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.status).toBe(404);
    expect(res.error.code).toBe('FEATURE_UNCONFIGURED');
  });
});

describe('capabilities + managedModels', () => {
  it('lights the data feature when a source with >=1 model is bound', async () => {
    const app = await makeCrudApp();
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.data).toBe(true);
  });

  it('managedModels.exclude hides a model everywhere', async () => {
    const app = await makeCrudApp({ managedModels: { exclude: ['post'] } });
    const models: StudioModelInfo[] = ok(await rpc(app, 'data.listModels'));
    expect(models.map((m) => m.name)).toEqual(['user']);

    const res = await rpc(app, 'data.describeModel', { model: 'post' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('STUDIO_UNKNOWN_MODEL');

    // Exclusion is enforced across every model-addressed read, not just describe:
    // listRows and facets on the excluded model also 404 with STUDIO_UNKNOWN_MODEL.
    const rows = await rpc(app, 'data.listRows', { model: 'post' });
    expect(rows.ok).toBe(false);
    if (rows.ok) throw new Error('expected error');
    expect(rows.status).toBe(404);
    expect(rows.error.code).toBe('STUDIO_UNKNOWN_MODEL');

    const facets = await rpc(app, 'data.facets', { model: 'post', field: 'status' });
    expect(facets.ok).toBe(false);
    if (facets.ok) throw new Error('expected error');
    expect(facets.status).toBe(404);
    expect(facets.error.code).toBe('STUDIO_UNKNOWN_MODEL');
  });

  it('reports data feature false when managedModels excludes every model', async () => {
    const app = await makeCrudApp({ managedModels: { exclude: ['user', 'post'] } });
    const models: StudioModelInfo[] = ok(await rpc(app, 'data.listModels'));
    expect(models).toEqual([]);
    const caps = ok(await rpc(app, 'studio.capabilities'));
    expect(caps.features.data).toBe(false);
  });
});

describe('database-qualified Studio resources', () => {
  function fixture(options: { exclude?: string[]; defaultDatabase?: 'alpha' | 'beta' } = {}) {
    const container = new Container();
    const alpha = new MemoryDb();
    const beta = new MemoryDb();
    const constructed = vi.fn();
    const bindings = [
      defineCrudDatabase('alpha', {
        handle: alpha,
        resources: {
          user: {
            model: userModel,
            adapter: memoryAdapter(userModel, alpha, ['transactions', 'cascade']),
          },
          post: { model: postModel, adapter: memoryAdapter(postModel, alpha, ['transactions']) },
        },
      }),
      defineCrudDatabase('beta', {
        handle: beta,
        resources: {
          user: {
            model: userModel,
            adapter: memoryAdapter(userModel, beta, ['transactions', 'cascade']),
          },
          post: { model: postModel, adapter: memoryAdapter(postModel, beta, ['transactions']) },
        },
      }),
    ];
    container.register(
      defineProvider(CRUD_DATABASES, {
        useValue: createCrudDatabaseRegistry(bindings, {
          defaultDatabase: options.defaultDatabase,
        }),
      }),
    );
    // Beta deliberately first: relation lookup must not select first-by-table.
    for (const database of ['beta', 'alpha'])
      for (const model of [userModel, postModel]) {
        @Injectable()
        class Resource {
          constructor() {
            constructed();
          }
        }
        defineMetadata(METADATA_KEYS.CRUD, { model, database } satisfies CrudConfig, Resource);
        container.register(Resource, `${database}-${model.name}`);
      }
    if (options.exclude) {
      container.register(
        defineProvider(STUDIO_DATA_OPTIONS, {
          useValue: { managedModels: { exclude: options.exclude } },
        }),
      );
    }
    const source = new CrudStudioModelSource(new DiscoveryService(container), container);
    return { source, alpha, beta, constructed, container, bindings };
  }

  it('reads and writes the selected database while keeping metadata inspection lazy', async () => {
    const { source, alpha, beta, constructed } = fixture();
    alpha.seed('users', [{ id: 'same', email: 'alpha@example.test' }]);
    beta.seed('users', [{ id: 'same', email: 'beta@example.test' }]);
    expect(
      source
        .listModels()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['alpha::post', 'alpha::user', 'beta::post', 'beta::user']);
    expect((await source.list('alpha::user', { model: 'alpha::user' })).rows[0]?.email).toBe(
      'alpha@example.test',
    );
    expect((await source.list('beta::user', { model: 'beta::user' })).rows[0]?.email).toBe(
      'beta@example.test',
    );
    expect(() => source.describe('user')).toThrow('unknown model');
    expect(source.describe('alpha::user').relations[0]?.target).toBe('alpha::post');
    expect(
      source.describe('alpha::post').columns.find((col) => col.name === 'authorId')?.fk?.table,
    ).toBe('alpha::user');
    await source.writeRow(
      'alpha::user',
      { model: 'alpha::user', id: 'same', patch: { email: 'updated@example.test' } },
      {},
    );
    expect((await source.list('alpha::user', { model: 'alpha::user' })).rows[0]?.email).toBe(
      'updated@example.test',
    );
    expect((await source.list('beta::user', { model: 'beta::user' })).rows[0]?.email).toBe(
      'beta@example.test',
    );
    expect(constructed).not.toHaveBeenCalled();
  });

  it('limits generated foreign keys and cascade visibility to the same database', async () => {
    const { source, alpha, beta } = fixture({ exclude: ['alpha::post'] });
    alpha.seed('users', [{ id: 'alpha-parent', email: 'a' }]);
    beta.seed('users', [{ id: 'beta-parent', email: 'b' }]);
    expect(
      (await source.cascadePreview({ model: 'alpha::user', ids: ['alpha-parent'] })).relations,
    ).toEqual([]);
    const unrestricted = fixture();
    unrestricted.alpha.seed('users', [{ id: 'alpha-parent', email: 'a' }]);
    unrestricted.beta.seed('users', [{ id: 'beta-parent', email: 'b' }]);
    await unrestricted.source.generateRows('alpha::post', { model: 'alpha::post', count: 1 }, {});
    expect(
      (await unrestricted.source.list('alpha::post', { model: 'alpha::post' })).rows[0]?.authorId,
    ).toBe('alpha-parent');
    expect(
      (await unrestricted.source.list('beta::post', { model: 'beta::post' })).rows,
    ).toHaveLength(0);
  });

  it('rejects colliding legacy names and explicit missing database selections', () => {
    const container = new Container();
    const db = new MemoryDb();
    const adapter = memoryAdapter(userModel, db, []);
    for (const owner of ['one', 'two']) {
      @Injectable()
      class Resource {}
      defineMetadata(
        METADATA_KEYS.CRUD,
        { model: userModel, adapter } satisfies CrudConfig,
        Resource,
      );
      container.register(Resource, owner);
    }
    expect(() =>
      new CrudStudioModelSource(new DiscoveryService(container), container).listModels(),
    ).toThrow('Ambiguous Studio resource');
    const missing = new Container();
    missing.register(defineProvider(CRUD_DEFAULT_ADAPTER, { useValue: adapter }));
    @Injectable()
    class Resource {}
    defineMetadata(
      METADATA_KEYS.CRUD,
      { model: userModel, database: 'missing' } satisfies CrudConfig,
      Resource,
    );
    missing.register(Resource);
    expect(() =>
      new CrudStudioModelSource(new DiscoveryService(missing), missing).listModels(),
    ).toThrow("Unknown database binding 'missing'");
  });

  it('consumes native compiled @Crud adapters and preserves a unique unnamed identity', async () => {
    const db = new MemoryDb();
    db.seed('users', [{ id: 'native', email: 'native@example.test' }]);
    const model = {
      ...userModel,
      schema: z.object({
        id: z.string(),
        email: z.string(),
        createdAt: z.number().optional(),
        updatedAt: z.number().optional(),
      }),
    };
    const adapter = memoryAdapter(model, db, []);
    class NativeResource {}
    Crud({ model, adapter, only: ['list'] })(NativeResource);
    const container = new Container();
    container.register(NativeResource);
    const source = new CrudStudioModelSource(new DiscoveryService(container), container);
    expect(source.listModels().map((entry) => entry.name)).toEqual(['user']);
    expect((await source.list('user', { model: 'user' })).rows[0]?.id).toBe('native');
  });

  it('honors the application default database for implicit resources', () => {
    const { bindings } = fixture();
    const container = new Container();
    container.register(
      defineProvider(CRUD_DATABASES, {
        useValue: createCrudDatabaseRegistry(bindings, { defaultDatabase: 'beta' }),
      }),
    );
    @Injectable()
    class Resource {}
    defineMetadata(METADATA_KEYS.CRUD, { model: userModel } satisfies CrudConfig, Resource);
    container.register(Resource);
    expect(
      new CrudStudioModelSource(new DiscoveryService(container), container)
        .listModels()
        .map((row) => row.name),
    ).toEqual(['beta::user']);
  });
});
