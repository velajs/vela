import { defineProvider } from '@velajs/vela';
/**
 * `@velajs/studio/crud` — the OPTIONAL crud binding for the data browser.
 *
 * This subpath is the ONLY module in the package that imports `@velajs/crud`
 * (the crud-drizzle optional-peer discipline): the core `.` entry never does, so
 * apps without crud still mount `StudioModule` and just report the `data`
 * feature false. An app WITH crud adds `crudPanel()` to
 * `StudioModule.forRoot({ plugins })`, which binds a {@link CrudStudioModelSource}
 * to the core `STUDIO_MODEL_SOURCE` token.
 *
 * The source discovers `@Crud`-stamped controllers via the public
 * `DiscoveryService` metadata and `getCrudConfig`, resolves each resource with
 * the shared CRUD database selection contract, and serves READS off the adapter contract —
 * bypassing the HTTP engine (policies/tenant/`runAsIdentity` are M7). Model
 * metadata comes from the normalized `Model`; column shapes are introspected
 * from the model's Zod schema. Everything crossing the wire is a frozen
 * `@velajs/studio-protocol` type.
 *
 * All of `@velajs/crud` is consumed through its PUBLIC entry points (`.`,
 * `./adapter`, `./model`) — no deep imports.
 */
import { Container, DiscoveryService, METADATA_KEYS } from '@velajs/vela/module-kit';
import { getCrudConfig, resolveCrudDatabaseSync } from '@velajs/crud';
import type { CrudConfig } from '@velajs/crud';
import type { AuditStore } from '@velajs/crud/audit';
import type { Model } from '@velajs/crud/model';
import type {
  AdapterScope,
  AggregateSpec,
  RuntimeAdapter,
  FilterCondition,
  ListQuery,
  Lookup,
  PageInfo,
  SearchQuery,
} from '@velajs/crud/adapter';
import type {
  CascadePreviewRequest,
  CascadePreviewResponse,
  ClearTableRequest,
  DeleteRowsRequest,
  FacetsRequest,
  FacetsResponse,
  GenerateRowsRequest,
  ListRowsRequest,
  StudioColumn,
  StudioGridFilter,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioPageInfo,
  StudioRowPage,
  WriteRowRequest,
} from '@velajs/studio-protocol';
import { STUDIO_DATA_OPTIONS, STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import type { StudioDataOptions } from '../data/model-source.port';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';
import type {
  StudioDeleteRowsOutcome,
  StudioGenerateRowsOutcome,
  StudioModelSource,
  StudioWriteContext,
  StudioWriteRowOutcome,
} from '../data/model-source.port';
import type { StudioChange, StudioChangeKind } from '@velajs/studio-protocol';
import type { TimeTravelScope } from '@velajs/studio-protocol';
import { studioConflict, studioError, studioNotFound } from '../studio.errors';
import { StudioDataWriteOps } from '../data/data.write.ops';
import type { ChangeSource } from '../timetravel/change-source.port';

/** Cap on per-row audit images (delete before-images / generate sample). */
const MAX_AUDIT_IMAGES = 50;

/** One untyped row image. */
type Row = Record<string, unknown>;

/** Default rows-per-page when a request omits `perPage`. */
const DEFAULT_PER_PAGE = 20;

/** One discovered, adapter-backed managed model. */
interface ManagedEntry {
  identity: string;
  database?: string;
  model: Model;
  adapter: RuntimeAdapter;
  /** Fields the inline `search` needle applies to (from `CrudConfig.searchFields`). */
  searchFields: string[];
}

// ---------------------------------------------------------------------------
// Zod schema introspection (structural — no `zod` import in this package)
// ---------------------------------------------------------------------------

/**
 * The subset of a Zod v4 type's internals we read to derive a column shape.
 * crud peers `zod >= 4`, whose `ZodType` exposes `.def.type` (+ `.def.innerType`
 * on wrappers) — the only shape this introspection depends on.
 */
interface ZodTypeLike {
  def?: { type?: string; innerType?: unknown };
}

/** The Zod v4 type tag (`.def.type`). */
function typeTag(field: ZodTypeLike | undefined): string | undefined {
  return field?.def?.type;
}

/** The wrapped inner type of an optional/nullable/default/… wrapper. */
function innerType(field: ZodTypeLike): ZodTypeLike | undefined {
  return field.def?.innerType as ZodTypeLike | undefined;
}

/** Peel optional/nullable/default/catch/readonly wrappers off a field. */
function unwrapField(field: unknown): { inner: ZodTypeLike | undefined; nullable: boolean } {
  let cur: ZodTypeLike | undefined = field as ZodTypeLike;
  let nullable = false;
  for (let guard = 0; cur !== undefined && guard < 12; guard++) {
    const tag = typeTag(cur);
    if (tag === 'optional' || tag === 'nullable') {
      nullable = true;
      cur = innerType(cur);
      continue;
    }
    if (tag === 'default' || tag === 'catch' || tag === 'readonly' || tag === 'nonoptional') {
      cur = innerType(cur);
      continue;
    }
    break;
  }
  return { inner: cur, nullable };
}

/** Map a Zod type tag onto the wire column type; unknowns degrade honestly. */
function mapColumnType(tag: string | undefined): StudioColumn['type'] {
  switch (tag) {
    case 'string':
      return 'string';
    case 'number':
    case 'int':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'object':
    case 'array':
    case 'record':
    case 'tuple':
    case 'map':
    case 'set':
      return 'json';
    case 'enum':
      // z.enum(...) is a set of string literals.
      return 'string';
    default:
      return 'unknown';
  }
}

/**
 * Derive the honest column set from a normalized model. Sourced fields: `name`
 * (schema shape keys), `type` (Zod tag), `pk` (`model.primaryKeys`), `nullable`
 * (optional/nullable wrappers), `unique` (pk OR a single-column `model.unique`
 * tuple), `fk` (a `belongsTo` relation whose `foreignKey` names the column),
 * `managed` (timestamp/soft-delete/tenant columns). Composite unique tuples are
 * not projected per-column, and `onSoftDelete` cascade is not surfaced here.
 */
function deriveColumns(model: Model): StudioColumn[] {
  const pks = new Set(model.primaryKeys);
  const managed = new Set<string>();
  if (model.timestamps.createdAt) managed.add(model.timestamps.createdAt);
  if (model.timestamps.updatedAt) managed.add(model.timestamps.updatedAt);
  if (model.softDeleteField !== undefined) managed.add(model.softDeleteField);
  if (model.tenantField !== undefined) managed.add(model.tenantField);

  const uniqueSingles = new Set<string>();
  for (const tuple of model.unique ?? []) {
    if (tuple.length === 1) uniqueSingles.add(tuple[0]);
  }

  const fkByColumn = new Map<string, { relation: string; target: string }>();
  for (const [relation, rel] of Object.entries(model.relations ?? {})) {
    if (rel.type === 'belongsTo') {
      fkByColumn.set(rel.foreignKey, { relation, target: rel.target ?? '' });
    }
  }

  const columns: StudioColumn[] = [];
  for (const [name, field] of Object.entries(model.schema.shape)) {
    const { inner, nullable } = unwrapField(field);
    const pk = pks.has(name);
    const fk = fkByColumn.get(name);
    columns.push({
      name,
      type: mapColumnType(typeTag(inner)),
      pk,
      nullable,
      unique: pk || uniqueSingles.has(name),
      ...(fk !== undefined ? { fk: { table: fk.target, relation: fk.relation } } : {}),
      managed: managed.has(name),
    });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Grid-query → crud ListQuery mapping
// ---------------------------------------------------------------------------

/** Map the grid filter clauses onto crud `FilterCondition`s (operators are a subset). */
function mapFilters(filters: StudioGridFilter[] | undefined): FilterCondition[] {
  return (filters ?? []).map((f) => ({ field: f.field, operator: f.operator, value: f.value }));
}

/** Structural mirror of crud `PageInfo` → wire `StudioPageInfo` (both snake_case). */
function toPageInfo(info: PageInfo): StudioPageInfo {
  return {
    page: info.page,
    per_page: info.per_page,
    ...(info.total_count !== undefined ? { total_count: info.total_count } : {}),
    ...(info.total_pages !== undefined ? { total_pages: info.total_pages } : {}),
    has_next_page: info.has_next_page,
    has_prev_page: info.has_prev_page,
    ...(info.next_cursor !== undefined ? { next_cursor: info.next_cursor } : {}),
  };
}

/** First numeric aggregate value in a bucket (the count), or 0. */
function firstCount(values: Record<string, number | null>): number {
  for (const value of Object.values(values)) {
    if (typeof value === 'number') return value;
  }
  return 0;
}

/** One descriptor relation entry from a normalized crud relation. */
function toRelation(
  name: string,
  rel: {
    type: 'hasOne' | 'hasMany' | 'belongsTo';
    target?: string;
    foreignKey: string;
    cascade?: { onDelete?: string };
  },
): StudioModelDescriptor['relations'][number] {
  const base = { name, type: rel.type, target: rel.target ?? '', foreignKey: rel.foreignKey };
  return rel.cascade?.onDelete !== undefined ? { ...base, cascade: rel.cascade.onDelete } : base;
}

// ---------------------------------------------------------------------------
// Adapter-direct write helpers (managed-field stamping, synthetic seeding)
//
// This is the honest fallback the M7a investigation settled on: the crud KERNEL
// re-derives DTOs and re-validates the body against the model's REAL Zod schema,
// which the studio fixtures deliberately fake — so writes go straight to the
// adapter contract (M5's read posture, extended). What the kernel would give for
// free is replicated here to the extent the model metadata allows: id generation
// + timestamp stamping, soft-delete-aware delete, and a unique pre-check → 409.
// What it does NOT replicate — policy/tenant evaluation and validation against
// the live schema — is documented in the report as the kernel-path deferral.
// ---------------------------------------------------------------------------

/** Generate a primary key for a create, or `undefined` when the db/caller assigns it. */
function generateId(strategy: Model['id']): string | undefined {
  if (typeof strategy === 'function') {
    const value = strategy();
    return typeof value === 'string' ? value : String(value);
  }
  return strategy === 'uuid' ? crypto.randomUUID() : undefined;
}

/** Build a create input: caller patch + generated id (if absent) + stamped timestamps. */
function stampCreate(model: Model, patch: Row, pk: string, now: number): Row {
  const input: Row = { ...patch };
  if (input[pk] === undefined) {
    const id = generateId(model.id);
    if (id !== undefined) input[pk] = id;
  }
  const { createdAt, updatedAt } = model.timestamps;
  if (createdAt !== false && input[createdAt] === undefined) input[createdAt] = now;
  if (updatedAt !== false && input[updatedAt] === undefined) input[updatedAt] = now;
  return input;
}

/** Build an update patch: caller patch + a refreshed `updatedAt` stamp. */
function stampUpdate(model: Model, patch: Row, now: number): Row {
  const out: Row = { ...patch };
  const { updatedAt } = model.timestamps;
  if (updatedAt !== false) out[updatedAt] = now;
  return out;
}

/** A deterministic synthetic value for a column, by wire type (no RNG — no seed in the protocol). */
function syntheticValue(type: StudioColumn['type'], name: string, n: number, now: number): unknown {
  switch (type) {
    case 'string':
      return `${name}-${n}`;
    case 'number':
      return n;
    case 'boolean':
      return n % 2 === 0;
    case 'date':
      return now - n * 86_400_000; // now minus n days (epoch ms)
    case 'json':
      return {};
    default:
      return null; // unknown
  }
}

// ---------------------------------------------------------------------------
// The crud-backed model source
// ---------------------------------------------------------------------------

/**
 * A {@link StudioModelSource} over discovered `@Crud` resources. Reads are
 * served directly against the {@link RuntimeAdapter} contract inside a
 * `requestScope()` scope. Capability-degrades
 * cleanly: `facets` requires the adapter's `aggregate` capability (else
 * `FEATURE_UNCONFIGURED`), inline `search` requires `nativeSearch` (else the
 * needle is ignored and a plain page is returned), `cursor` requires the
 * `cursor` capability (else falls back to page/perPage).
 */
export class CrudStudioModelSource implements StudioModelSource {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly container: Container,
  ) {}

  listModels(): StudioModelInfo[] {
    return [...this.index().values()].map((entry) => ({
      name: entry.identity,
      database: entry.database,
      table: entry.model.tableName,
      label: entry.model.namePlural,
      capabilities: [...entry.adapter.capabilities],
    }));
  }

  describe(model: string): StudioModelDescriptor {
    const index = this.index();
    const entry = index.get(model);
    if (entry === undefined) throw studioError('STUDIO_UNKNOWN_MODEL', `unknown model '${model}'`);
    const { model: m, adapter } = entry;
    return {
      name: entry.identity,
      ...(entry.database === undefined ? {} : { database: entry.database }),
      table: m.tableName,
      primaryKeys: m.primaryKeys,
      columns: deriveColumns(m).map((column) => {
        if (column.fk !== undefined && entry.database !== undefined) {
          column.fk.table = this.relationIdentity(entry, column.fk.table, index);
        }
        return column;
      }),
      relations: Object.entries(m.relations ?? {}).map(([name, rel]) => {
        const relation = toRelation(name, rel);
        if (entry.database !== undefined) {
          relation.target = this.relationIdentity(entry, relation.target, index);
        }
        return relation;
      }),
      flags: {
        softDelete: m.softDeleteField !== undefined,
        multiTenant: m.tenantField !== undefined,
        versioning: m.versioning,
        audit: m.audit,
      },
      supports: {
        bulkWrites: adapter.capabilities.has('transactions'),
        facets: adapter.capabilities.has('aggregate'),
        search: adapter.capabilities.has('nativeSearch'),
        cascade: adapter.capabilities.has('cascade'),
      },
    };
  }

  async list(model: string, request: ListRowsRequest): Promise<StudioRowPage> {
    const entry = this.entryFor(model);
    const page = request.page ?? 1;
    const perPage = request.perPage ?? DEFAULT_PER_PAGE;

    const searchable =
      typeof request.search === 'string' &&
      request.search.length > 0 &&
      entry.adapter.search !== undefined &&
      entry.adapter.capabilities.has('nativeSearch');
    if (searchable) {
      return this.searchPage(entry, request, page, perPage);
    }

    const query: ListQuery = {
      filters: mapFilters(request.filters),
      options: {
        page,
        per_page: perPage,
        ...(request.sort !== undefined
          ? { order_by: request.sort.field, order_by_direction: request.sort.order }
          : {}),
        ...(request.withDeleted === true ? { withDeleted: true } : {}),
        ...(request.cursor !== undefined && entry.adapter.capabilities.has('cursor')
          ? { cursor: request.cursor, limit: perPage }
          : {}),
      },
    };
    const result = await entry.adapter.requestScope((scope: AdapterScope) =>
      entry.adapter.list(query, scope),
    );
    return {
      rows: result.result,
      info: toPageInfo(result.result_info),
    };
  }

  async readOne(model: string, id: string): Promise<Record<string, unknown> | null> {
    const entry = this.entryFor(model);
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const lookup: Lookup = { field: pk, value: String(id) };
    // Admin reads see soft-deleted rows too (row inspection, not a live query).
    const row = await entry.adapter.requestScope((scope: AdapterScope) =>
      entry.adapter.readOne(lookup, { withDeleted: true }, scope),
    );
    return row ?? null;
  }

  async facets(request: FacetsRequest): Promise<FacetsResponse> {
    const entry = this.entryFor(request.model);
    if (!entry.adapter.capabilities.has('aggregate') || entry.adapter.aggregate === undefined) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        `model '${request.model}' has no aggregate-capable adapter for facets`,
      );
    }
    const aggregate = entry.adapter.aggregate.bind(entry.adapter);
    const spec: AggregateSpec = {
      operation: 'count',
      aggregations: [{ operation: 'count', field: '*' }],
      groupBy: [request.field],
      filters: mapFilters(request.filters),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };
    const result = await entry.adapter.requestScope((scope: AdapterScope) =>
      aggregate(spec, scope),
    );
    const buckets = (result.groups ?? []).map((group) => ({
      value: group.key[request.field],
      count: firstCount(group.values),
    }));
    return { buckets };
  }

  async cascadePreview(request: CascadePreviewRequest): Promise<CascadePreviewResponse> {
    const index = this.index();
    const entry = index.get(request.model);
    if (entry === undefined) {
      throw studioError('STUDIO_UNKNOWN_MODEL', `unknown model '${request.model}'`);
    }
    // Privacy parity with `list`/`facets`: those 404 an excluded model outright,
    // so a cascade preview must not leak that same model back through a
    // neighbor's relation — not even an aggregate `affected` count. Relations
    // whose TARGET model is not itself managed (excluded via `managedModels`, or
    // simply not a discovered resource) are skipped entirely. Visible targets
    // are matched by model name OR table name (relation `target` is normalized
    // to the sibling's `tableName`).
    const visibleTargets = new Set<string>();
    for (const managed of index.values()) {
      if (managed.database !== entry.database) continue;
      visibleTargets.add(managed.model.name);
      visibleTargets.add(managed.model.tableName);
    }
    const cascade =
      entry.adapter.capabilities.has('cascade') && entry.adapter.cascade !== undefined
        ? entry.adapter.cascade
        : undefined;
    const relations: CascadePreviewResponse['relations'] = [];
    for (const [name, rel] of Object.entries(entry.model.relations ?? {})) {
      // Children referencing this model via the FK are what a delete cascades to.
      if (rel.type !== 'hasMany' && rel.type !== 'hasOne') continue;
      // Skip relations that point at an unmanaged (e.g. excluded) target model.
      if (!visibleTargets.has(rel.target ?? '')) continue;
      const action = rel.cascade?.onDelete ?? 'noAction';
      let affected = 0;
      if (cascade !== undefined) {
        for (const id of request.ids) {
          affected += await entry.adapter.requestScope((scope: AdapterScope) =>
            cascade.countRelated(name, id, scope),
          );
        }
      }
      relations.push({
        relation: name,
        target: this.relationIdentity(entry, rel.target ?? '', index),
        action,
        affected,
      });
    }
    return { relations };
  }

  // --- writes (adapter-direct; see the write-helpers header above) ---------

  async writeRow(
    model: string,
    request: WriteRowRequest,
    _ctx: StudioWriteContext,
  ): Promise<StudioWriteRowOutcome> {
    const entry = this.entryFor(model);
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const now = Date.now();

    if (request.id !== undefined) {
      const lookup: Lookup = { field: pk, value: String(request.id) };
      const before = await entry.adapter.requestScope((scope: AdapterScope) =>
        entry.adapter.readOne(lookup, { withDeleted: true }, scope),
      );
      if (before === null) throw studioNotFound(`row '${request.id}' not found in '${model}'`);
      const patch = stampUpdate(entry.model, request.patch, now);
      await this.assertUnique(entry, { ...before, ...patch }, String(request.id));
      const after = await entry.adapter.requestScope((scope: AdapterScope) =>
        entry.adapter.update(lookup, patch, scope),
      );
      if (after === null) throw studioNotFound(`row '${request.id}' not found in '${model}'`);
      return { after, before };
    }

    const input = stampCreate(entry.model, request.patch, pk, now);
    await this.assertUnique(entry, input, undefined);
    const after = await entry.adapter.requestScope((scope: AdapterScope) =>
      entry.adapter.create(input, scope),
    );
    return { after, before: null };
  }

  async deleteRows(
    model: string,
    request: DeleteRowsRequest,
    _ctx: StudioWriteContext,
  ): Promise<StudioDeleteRowsOutcome> {
    const entry = this.entryFor(model);
    const soft = request.mode === 'soft';
    if (soft && entry.model.softDeleteField === undefined) {
      throw studioConflict(`model '${model}' has no soft-delete column`, 'use mode: "hard"');
    }
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const softField = soft ? entry.model.softDeleteField : undefined;
    const before: Row[] = [];
    let beforeCapped = false;
    let deleted = 0;

    if (!entry.adapter.capabilities.has('transactions')) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'This bulk operation requires an adapter with transactions.',
      );
    }
    await entry.adapter.transaction(async (scope: AdapterScope) => {
      for (const id of request.ids) {
        const lookup: Lookup = { field: pk, value: String(id) };
        const existing = await entry.adapter.readOne(lookup, { withDeleted: true }, scope);
        const removed = await entry.adapter.delete(
          lookup,
          softField !== undefined ? { softDeleteField: softField } : {},
          scope,
        );
        if (removed === null) continue;
        deleted++;
        if (before.length < MAX_AUDIT_IMAGES) before.push(existing ?? removed);
        else beforeCapped = true;
      }
    });

    return { deleted, before, beforeCapped };
  }

  async clearTable(
    model: string,
    _request: ClearTableRequest,
    _ctx: StudioWriteContext,
  ): Promise<{ deleted: number }> {
    const entry = this.entryFor(model);
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const perPage = 500;
    let deleted = 0;

    if (!entry.adapter.capabilities.has('transactions')) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'This bulk operation requires an adapter with transactions.',
      );
    }
    await entry.adapter.transaction(async (scope: AdapterScope) => {
      // Drain the table by repeatedly reading (incl. tombstones) and hard-deleting
      // the first page; stop when a batch removes nothing (empty or unremovable).
      for (;;) {
        const page = await entry.adapter.list(
          { filters: [], options: { page: 1, per_page: perPage, withDeleted: true } },
          scope,
        );
        const rows = page.result;
        if (rows.length === 0) break;
        let batch = 0;
        for (const row of rows) {
          const removed = await entry.adapter.delete(
            { field: pk, value: String(row[pk]) },
            {},
            scope,
          );
          if (removed !== null) {
            deleted++;
            batch++;
          }
        }
        if (batch === 0) break;
      }
    });

    return { deleted };
  }

  async generateRows(
    model: string,
    request: GenerateRowsRequest,
    _ctx: StudioWriteContext,
  ): Promise<StudioGenerateRowsOutcome> {
    const entry = this.entryFor(model);
    const columns = deriveColumns(entry.model);
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const count = Math.max(0, Math.floor(request.count));
    const fkPools = await this.fkPools(columns, entry.database);
    const now = Date.now();
    const sample: Row[] = [];
    let sampleCapped = false;
    let inserted = 0;

    if (!entry.adapter.capabilities.has('transactions')) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'This bulk operation requires an adapter with transactions.',
      );
    }
    await entry.adapter.transaction(async (scope: AdapterScope) => {
      for (let n = 0; n < count; n++) {
        const input: Row = {};
        for (const col of columns) {
          if (col.pk || col.managed) continue; // id + timestamps stamped below
          if (col.fk !== undefined) {
            const pool = fkPools.get(col.name);
            if (pool !== undefined && pool.length > 0) input[col.name] = pool[n % pool.length];
            continue; // no parent rows → leave unset (honest FK behavior)
          }
          input[col.name] = syntheticValue(col.type, col.name, n, now);
        }
        // Caller overrides win over synthesized values.
        Object.assign(input, request.overrides ?? {});
        const row = await entry.adapter.create(stampCreate(entry.model, input, pk, now), scope);
        inserted++;
        if (sample.length < MAX_AUDIT_IMAGES) sample.push(row);
        else sampleCapped = true;
      }
    });

    return { inserted, sample, sampleCapped };
  }

  /**
   * Assert the row does not violate any single/composite unique tuple (nor the
   * primary key), excluding the row's own id on update. Checks LIVE rows only —
   * a tombstoned duplicate does not block (partial-unique parity). Tuples with a
   * null/undefined member are skipped (SQL uniqueness ignores nulls).
   */
  private async assertUnique(
    entry: ManagedEntry,
    row: Row,
    excludeId: string | undefined,
  ): Promise<void> {
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const tuples: string[][] = [entry.model.primaryKeys, ...(entry.model.unique ?? [])];
    for (const tuple of tuples) {
      if (tuple.length === 0) continue;
      const filters: FilterCondition[] = [];
      let skip = false;
      for (const col of tuple) {
        const value = row[col];
        if (value === undefined || value === null) {
          skip = true;
          break;
        }
        filters.push({ field: col, operator: 'eq', value });
      }
      if (skip) continue;
      const page = await entry.adapter.requestScope((scope: AdapterScope) =>
        entry.adapter.list({ filters, options: { page: 1, per_page: 2 } }, scope),
      );
      const clash = page.result.some((r) => excludeId === undefined || String(r[pk]) !== excludeId);
      if (clash) {
        throw studioConflict(
          `unique constraint on (${tuple.join(', ')}) violated in '${entry.model.name}'`,
          'change the conflicting value(s) or update the existing row',
        );
      }
    }
  }

  /** Gather existing parent-id pools for each fk column so generated rows stay fk-valid. */
  private async fkPools(
    columns: StudioColumn[],
    database: string | undefined,
  ): Promise<Map<string, unknown[]>> {
    const index = this.index();
    const pools = new Map<string, unknown[]>();
    for (const col of columns) {
      const fk = col.fk;
      if (fk === undefined) continue;
      let parent: ManagedEntry | undefined;
      for (const entry of index.values()) {
        if (entry.database !== database) continue;
        if (entry.model.tableName === fk.table || entry.model.name === fk.table) {
          if (parent !== undefined) throw studioConflict(`Ambiguous related table '${fk.table}'`);
          parent = entry;
        }
      }
      if (parent === undefined) continue;
      const parentPk = parent.model.primaryKeys[0] ?? 'id';
      const page = await parent.adapter.requestScope((scope: AdapterScope) =>
        parent.adapter.list({ filters: [], options: { page: 1, per_page: 100 } }, scope),
      );
      const ids = page.result
        .map((r) => r[parentPk])
        .filter((v): v is unknown => v !== undefined && v !== null);
      pools.set(col.name, ids);
    }
    return pools;
  }

  /** Serve an inline-search page off the adapter's native search. */
  private async searchPage(
    entry: ManagedEntry,
    request: ListRowsRequest,
    page: number,
    perPage: number,
  ): Promise<StudioRowPage> {
    const search = entry.adapter.search!.bind(entry.adapter);
    const spec: SearchQuery = {
      term: request.search ?? '',
      mode: 'any',
      fields: entry.searchFields.map((field) => ({ field })),
      filters: mapFilters(request.filters),
      options: {
        page,
        per_page: perPage,
        ...(request.withDeleted === true ? { withDeleted: true } : {}),
      },
    };
    const hits = await entry.adapter.requestScope((scope: AdapterScope) => search(spec, scope));
    const rows = hits.map((hit) => hit.record);
    return {
      rows,
      info: {
        page,
        per_page: perPage,
        has_next_page: rows.length >= perPage,
        has_prev_page: page > 1,
      },
    };
  }

  private relationIdentity(
    entry: ManagedEntry,
    target: string,
    index: Map<string, ManagedEntry>,
  ): string {
    if (entry.database === undefined) return target;
    const matches = [...index.values()].filter(
      (candidate) =>
        candidate.database === entry.database &&
        (candidate.model.tableName === target || candidate.model.name === target),
    );
    if (matches.length > 1) throw studioConflict(`Ambiguous related table '${target}'`);
    return (
      matches[0]?.identity ?? `${encodeURIComponent(entry.database)}::${encodeURIComponent(target)}`
    );
  }

  /** The managed entry for `model`, or `STUDIO_UNKNOWN_MODEL`. */
  private entryFor(model: string): ManagedEntry {
    const entry = this.index().get(model);
    if (entry === undefined) {
      throw studioError('STUDIO_UNKNOWN_MODEL', `unknown model '${model}'`);
    }
    return entry;
  }

  /**
   * Discover every `@Crud` resource, resolve its adapter, and apply the
   * `managedModels` filter. Named database resources use escaped database::resource
   * identities; unnamed resources retain their model name. Metadata-only discovery
   * preserves lazy modules. Ambiguous identities and invalid selections fail closed.
   */
  private index(): Map<string, ManagedEntry> {
    const config = this.dataOptions();
    const include = config?.managedModels?.include;
    const exclude = config?.managedModels?.exclude;
    const map = new Map<string, ManagedEntry>();
    for (const found of this.discovery.registrationsWithMeta<CrudConfig>(METADATA_KEYS.CRUD, {
      metadataOnly: true,
    })) {
      // Native @Crud records compiled runtime config. Keep metadata-only legacy
      // integrations working without interpreting their authoring hooks.
      const runtime =
        getCrudConfig(found.metatype) ??
        (found.meta?.model === undefined
          ? undefined
          : {
              model: found.meta.model,
              adapter: found.meta.adapter?.runtime,
              database: found.meta.database,
              databaseResource: found.meta.databaseResource,
              searchFields: found.meta.searchFields,
            });
      if (runtime === undefined) continue;
      const crudConfig = resolveCrudDatabaseSync(this.container, runtime);
      const identity =
        crudConfig.database === undefined
          ? crudConfig.model.name
          : `${encodeURIComponent(crudConfig.database)}::${encodeURIComponent(crudConfig.databaseResource ?? crudConfig.model.name)}`;
      const { name, tableName } = crudConfig.model;
      if (
        include !== undefined &&
        include.length > 0 &&
        !include.includes(identity) &&
        !include.includes(name) &&
        !include.includes(tableName)
      ) {
        continue;
      }
      if (
        exclude !== undefined &&
        (exclude.includes(identity) || exclude.includes(name) || exclude.includes(tableName))
      ) {
        continue;
      }
      if (map.has(identity))
        throw studioConflict(
          `Ambiguous Studio resource '${identity}'; use distinct named database resources.`,
        );
      map.set(identity, {
        identity,
        database: crudConfig.database,
        model: crudConfig.model,
        adapter: crudConfig.adapter,
        searchFields: crudConfig.searchFields ?? [],
      });
    }
    return map;
  }

  private dataOptions(): StudioDataOptions | undefined {
    return this.container.has(STUDIO_DATA_OPTIONS)
      ? this.container.resolve(STUDIO_DATA_OPTIONS)
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * The data browser over `@Crud` resources: binds {@link CrudStudioModelSource}
 * to `STUDIO_MODEL_SOURCE` and registers the data WRITE ops, lighting the
 * `data` and `transfer` features:
 * `StudioModule.forRoot({ plugins: [crudPanel({ managedModels: { include: ['todo'] } })] })`.
 */
export function crudPanel(options: StudioDataOptions = {}): StudioPlugin {
  const settings = Object.freeze({ ...options });
  return defineStudioPlugin({
    name: 'crud',
    providers: [
      defineProvider(STUDIO_DATA_OPTIONS, { useValue: settings }),
      defineProvider(STUDIO_MODEL_SOURCE, {
        useFactory: (discovery: DiscoveryService, container: Container) =>
          new CrudStudioModelSource(discovery, container),
        inject: [DiscoveryService, Container],
      }),
      // The data WRITE ops. Registered with the source (not on core StudioModule)
      // because a write is meaningless without one; the dispatch registry
      // discovers their `@AdminRpc`/`@AdminConfirmSummary` methods across the graph.
      StudioDataWriteOps,
    ],
  });
}

// ---------------------------------------------------------------------------
// Audit-backed CDC change source (the zero-seam `snapshot+cdc` path)
// ---------------------------------------------------------------------------

/** Options for {@link AuditStoreChangeSource}. */
export interface AuditStoreChangeSourceOptions {
  /**
   * The row primary-key field used to build a change's `key`. Default `'id'`.
   * The adapter only relies on this as a fallback — the before/after images
   * carry the real primary key — so a non-`id` pk still replays correctly.
   */
  primaryKeyField?: string;
}

/** Infer a change kind from the presence of the before/after images (action-enum agnostic). */
function inferChangeKind(hasAfter: boolean, hasBefore: boolean): StudioChangeKind | null {
  if (hasAfter && !hasBefore) return 'insert';
  if (hasAfter && hasBefore) return 'update';
  if (!hasAfter && hasBefore) return 'delete';
  return null;
}

/**
 * A {@link ChangeSource} over a crud {@link AuditStore} (`@velajs/crud/audit`) —
 * the zero-seam CDC path: it READS the audit log's `query()` change history
 * (before/after/timestamp per row) rather than adding a `changeFeed` capability
 * to crud. Bind it to the time-travel module (`StudioTimeTravelModule.forRoot({
 * changeSource })`) to enable `snapshot+cdc` restore-to-a-time.
 *
 * The app supplies its OWN `AuditStore` instance — the wired default store sits
 * behind an internal crud token, so there is no public accessor for it (M8a
 * investigation). This class only ever touches the PUBLIC `AuditStore.query`
 * contract, so it works with `MemoryAuditStore` or any custom store.
 */
export class AuditStoreChangeSource implements ChangeSource {
  constructor(
    private readonly store: AuditStore,
    private readonly options: AuditStoreChangeSourceOptions = {},
  ) {}

  async changesBetween(
    table: string,
    fromTs: number,
    toTs: number,
    _scope?: TimeTravelScope,
  ): Promise<StudioChange[]> {
    const entries = await this.store.query({
      tableName: table,
      startDate: new Date(fromTs),
      endDate: new Date(toTs),
    });
    const pk = this.options.primaryKeyField ?? 'id';
    const changes: StudioChange[] = [];
    for (const entry of entries) {
      const ts = entry.timestamp.getTime();
      if (ts <= fromTs || ts > toTs) continue; // enforce the half-open window exactly
      const kind = inferChangeKind(entry.record !== undefined, entry.previousRecord !== undefined);
      if (kind === null) continue;
      changes.push({
        ts,
        table: entry.tableName,
        kind,
        key: { [pk]: entry.recordId },
        ...(entry.previousRecord !== undefined ? { before: entry.previousRecord } : {}),
        ...(entry.record !== undefined ? { after: entry.record } : {}),
      });
    }
    return changes.toSorted((a, b) => a.ts - b.ts);
  }
}
