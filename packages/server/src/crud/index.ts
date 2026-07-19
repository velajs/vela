/**
 * `@velajs/studio/crud` — the OPTIONAL crud binding for the data browser.
 *
 * This subpath is the ONLY module in the package that imports `@velajs/crud`
 * (the crud-drizzle optional-peer discipline): the core `.` entry never does, so
 * apps without crud still mount `StudioModule` and just report the `data`
 * feature false. An app WITH crud additionally imports `StudioCrudModule`, which
 * binds a {@link CrudStudioModelSource} to the core `STUDIO_MODEL_SOURCE` token.
 *
 * The source discovers `@Crud`-stamped controllers via the public
 * `DiscoveryService` (`providersWithMeta(METADATA_KEYS.CRUD)` → the stamped
 * `CrudConfig`), resolves each resource's adapter (`config.adapter` else the
 * `CRUD_DEFAULT_ADAPTER`), and serves READS straight off the adapter contract —
 * bypassing the HTTP engine (policies/tenant/`runAsIdentity` are M7). Model
 * metadata comes from the normalized `Model`; column shapes are introspected
 * from the model's Zod schema. Everything crossing the wire is a frozen
 * `@velajs/studio-protocol` type.
 *
 * All of `@velajs/crud` is consumed through its PUBLIC entry points (`.`,
 * `./adapter`, `./model`) — no deep imports.
 */
import { Container, DiscoveryService, METADATA_KEYS, defineModule } from '@velajs/vela';
import { CRUD_DEFAULT_ADAPTER } from '@velajs/crud';
import type { CrudConfig } from '@velajs/crud';
import type { Model } from '@velajs/crud/model';
import type {
  AdapterScope,
  AggregateSpec,
  CrudAdapter,
  FilterCondition,
  ListQuery,
  Lookup,
  PageInfo,
  SearchQuery,
} from '@velajs/crud/adapter';
import type {
  CascadePreviewRequest,
  CascadePreviewResponse,
  FacetsRequest,
  FacetsResponse,
  ListRowsRequest,
  StudioColumn,
  StudioGridFilter,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioPageInfo,
  StudioRowPage,
} from '@velajs/studio-protocol';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import type { StudioModelSource } from '../data/model-source.port';
import { studioError } from '../studio.errors';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import type { ResolvedStudioConfig } from '../studio.types';

/** Default rows-per-page when a request omits `perPage`. */
const DEFAULT_PER_PAGE = 20;

/** One discovered, adapter-backed managed model. */
interface ManagedEntry {
  model: Model;
  adapter: CrudAdapter;
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
// The crud-backed model source
// ---------------------------------------------------------------------------

/**
 * A {@link StudioModelSource} over discovered `@Crud` resources. Reads are
 * served directly against the {@link CrudAdapter} contract inside a
 * `transaction()` scope (a no-op for memory adapters). Capability-degrades
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
      name: entry.model.name,
      table: entry.model.tableName,
      label: entry.model.namePlural,
      capabilities: [...entry.adapter.capabilities],
    }));
  }

  describe(model: string): StudioModelDescriptor {
    const { model: m, adapter } = this.entryFor(model);
    return {
      name: m.name,
      table: m.tableName,
      primaryKeys: m.primaryKeys,
      columns: deriveColumns(m),
      relations: Object.entries(m.relations ?? {}).map(([name, rel]) => toRelation(name, rel)),
      flags: {
        softDelete: m.softDeleteField !== undefined,
        multiTenant: m.tenantField !== undefined,
        versioning: m.versioning,
        audit: m.audit,
      },
      supports: {
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
    const result = await entry.adapter.transaction((scope: AdapterScope) =>
      entry.adapter.list(query, scope),
    );
    return {
      rows: result.result as Array<Record<string, unknown>>,
      info: toPageInfo(result.result_info),
    };
  }

  async readOne(model: string, id: string): Promise<Record<string, unknown> | null> {
    const entry = this.entryFor(model);
    const pk = entry.model.primaryKeys[0] ?? 'id';
    const lookup: Lookup = { field: pk, value: String(id) };
    // Admin reads see soft-deleted rows too (row inspection, not a live query).
    const row = await entry.adapter.transaction((scope: AdapterScope) =>
      entry.adapter.readOne(lookup, { withDeleted: true }, scope),
    );
    return (row ?? null) as Record<string, unknown> | null;
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
    const result = await entry.adapter.transaction((scope: AdapterScope) => aggregate(spec, scope));
    const buckets = (result.groups ?? []).map((group) => ({
      value: group.key[request.field],
      count: firstCount(group.values),
    }));
    return { buckets };
  }

  async cascadePreview(request: CascadePreviewRequest): Promise<CascadePreviewResponse> {
    const entry = this.entryFor(request.model);
    const cascade =
      entry.adapter.capabilities.has('cascade') && entry.adapter.cascade !== undefined
        ? entry.adapter.cascade
        : undefined;
    const relations: CascadePreviewResponse['relations'] = [];
    for (const [name, rel] of Object.entries(entry.model.relations ?? {})) {
      // Children referencing this model via the FK are what a delete cascades to.
      if (rel.type !== 'hasMany' && rel.type !== 'hasOne') continue;
      const action = rel.cascade?.onDelete ?? 'noAction';
      let affected = 0;
      if (cascade !== undefined) {
        for (const id of request.ids) {
          affected += await entry.adapter.transaction((scope: AdapterScope) =>
            cascade.countRelated(name, id, scope),
          );
        }
      }
      relations.push({ relation: name, target: rel.target ?? '', action, affected });
    }
    return { relations };
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
    const hits = await entry.adapter.transaction((scope: AdapterScope) => search(spec, scope));
    const rows = hits.map((hit) => hit.record as Record<string, unknown>);
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
   * `managedModels` include/exclude filter — keyed by model name (table name
   * accepted as an alias). Rebuilt per call: cheap (singleton controllers
   * re-resolve to their cached instance) and never stale against lazily
   * materialized crud modules.
   */
  private index(): Map<string, ManagedEntry> {
    const config = this.resolvedConfig();
    const include = config?.managedModels?.include;
    const exclude = config?.managedModels?.exclude;
    const map = new Map<string, ManagedEntry>();
    for (const found of this.discovery.providersWithMeta<CrudConfig>(METADATA_KEYS.CRUD)) {
      const crudConfig = found.meta;
      if (crudConfig?.model === undefined) continue;
      const adapter = crudConfig.adapter ?? this.defaultAdapter();
      if (adapter === undefined) continue;
      const { name, tableName } = crudConfig.model;
      if (
        include !== undefined &&
        include.length > 0 &&
        !include.includes(name) &&
        !include.includes(tableName)
      ) {
        continue;
      }
      if (exclude !== undefined && (exclude.includes(name) || exclude.includes(tableName))) {
        continue;
      }
      map.set(name, {
        model: crudConfig.model,
        adapter: adapter as CrudAdapter,
        searchFields: crudConfig.searchFields ?? [],
      });
    }
    return map;
  }

  private defaultAdapter(): CrudAdapter | undefined {
    return this.container.has(CRUD_DEFAULT_ADAPTER)
      ? this.container.resolve(CRUD_DEFAULT_ADAPTER)
      : undefined;
  }

  private resolvedConfig(): ResolvedStudioConfig | undefined {
    return this.container.has(STUDIO_RESOLVED_CONFIG)
      ? this.container.resolve(STUDIO_RESOLVED_CONFIG)
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/** Options for {@link StudioCrudModule}. Reserved for M7 write wiring. */
export type StudioCrudModuleOptions = Record<string, never>;

const { ConfigurableModuleClass } = defineModule<StudioCrudModuleOptions>({
  name: 'StudioCrud',
  setup: () => ({
    providers: [
      {
        provide: STUDIO_MODEL_SOURCE,
        useFactory: (discovery: DiscoveryService, container: Container) =>
          new CrudStudioModelSource(discovery, container),
        inject: [DiscoveryService, Container],
      },
    ],
    exports: [STUDIO_MODEL_SOURCE],
  }),
});

/**
 * Binds {@link CrudStudioModelSource} to `STUDIO_MODEL_SOURCE`. Import it with
 * `StudioCrudModule.forRoot({})` ALONGSIDE `StudioModule` in apps that use crud
 * — this is the seam that lights the `data` feature.
 */
export class StudioCrudModule extends ConfigurableModuleClass {}
