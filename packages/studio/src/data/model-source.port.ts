/**
 * The data-browser source port. Studio's `data.*` read ops are authored ONCE,
 * against this interface, and never against `@velajs/crud` directly — so the
 * core `.` entry stays crud-free (the optional-peer discipline) and a BYO
 * non-crud source can bind the same {@link STUDIO_MODEL_SOURCE} token later.
 *
 * The crud-backed implementation lives in the `@velajs/studio/crud` subpath
 * ({@link import('../crud/index').CrudStudioModelSource}); it is the only module
 * that imports crud, and it is loaded only by apps that actually have crud.
 *
 * Discovery methods (`listModels`/`describe`) are SYNC — they read model
 * metadata only (no adapter I/O), so the capability probe can call `listModels`
 * inside the synchronous `studio.capabilities` handler. Row access is async
 * (it touches the adapter). `facets`/`cascadePreview` are OPTIONAL: a source
 * that cannot serve them omits the method and the op reports
 * `FEATURE_UNCONFIGURED`.
 *
 * Contract for implementers: an unknown model MUST throw
 * `studioError('STUDIO_UNKNOWN_MODEL')` from every model-addressed method.
 */
import { InjectionToken } from '@velajs/vela';
import type {
  CascadePreviewRequest,
  CascadePreviewResponse,
  ClearTableRequest,
  DeleteRowsRequest,
  FacetsRequest,
  FacetsResponse,
  GenerateRowsRequest,
  ListRowsRequest,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioRowPage,
  WriteRowRequest,
} from '@velajs/studio-protocol';
import type { StudioRunAsIdentity } from '../studio.types';

/** A single untyped row image. */
type Row = Record<string, unknown>;

/**
 * Per-write dispatch context threaded from the op handler into the source. The
 * `identity` is the resolved {@link StudioRunAsIdentity} (present only when the
 * `identity` gate is open). A kernel-backed source would forward it into
 * `EngineRequest.vars`; the adapter-direct source ignores it for execution and
 * the handler audits its subject.
 */
export interface StudioWriteContext {
  identity?: StudioRunAsIdentity;
}

/** Outcome of a `writeRow`: the post-write row plus the pre-write image for audit. */
export interface StudioWriteRowOutcome {
  /** Post-write row — the wire result AND the audit `after` image. */
  after: Row;
  /** Pre-write row: `null` on create, the prior row on update. */
  before: Row | null;
}

/** Outcome of a `deleteRows`: the deleted count plus a bounded set of before-images. */
export interface StudioDeleteRowsOutcome {
  deleted: number;
  /** Before-images of deleted rows, capped by the source (see the cap note). */
  before: Row[];
  /** True when `before` was truncated below the true `deleted` count. */
  beforeCapped: boolean;
}

/** Outcome of a `generateRows`: the inserted count plus a bounded row sample for audit. */
export interface StudioGenerateRowsOutcome {
  inserted: number;
  /** Inserted rows, capped by the source (audit sample). */
  sample: Row[];
  /** True when `sample` was truncated below `inserted`. */
  sampleCapped: boolean;
}

/**
 * A bindable source of model metadata + row reads for the data browser. All
 * shapes are the frozen `@velajs/studio-protocol` wire types — never re-declared.
 */
export interface StudioModelSource {
  /** Every managed model, honestly capability-tagged. */
  listModels(): StudioModelInfo[];
  /** Full descriptor for one model. Unknown model ⇒ `STUDIO_UNKNOWN_MODEL`. */
  describe(model: string): StudioModelDescriptor;
  /** A page of rows under the grid query grammar. */
  list(model: string, request: ListRowsRequest): Promise<StudioRowPage>;
  /** A single row by id, or `null` when absent. */
  readOne(model: string, id: string): Promise<Record<string, unknown> | null>;
  /** Faceted counts for a field — present only on aggregate-capable sources. */
  facets?(request: FacetsRequest): Promise<FacetsResponse>;
  /** Cascade-delete impact preview — present only on relation-aware sources. */
  cascadePreview?(request: CascadePreviewRequest): Promise<CascadePreviewResponse>;

  // --- writes (present only on write-capable sources; a read-only BYO source
  // omits them and the write ops report FEATURE_UNCONFIGURED) ---------------

  /** Create (id absent) or patch-update (id present) a row. Unknown model ⇒ `STUDIO_UNKNOWN_MODEL`. */
  writeRow?(
    model: string,
    request: WriteRowRequest,
    ctx: StudioWriteContext,
  ): Promise<StudioWriteRowOutcome>;
  /** Soft- or hard-delete rows by id. Soft on a non-soft-delete model ⇒ 409. */
  deleteRows?(
    model: string,
    request: DeleteRowsRequest,
    ctx: StudioWriteContext,
  ): Promise<StudioDeleteRowsOutcome>;
  /** Hard-delete every row of the model. Returns the deleted count. */
  clearTable?(
    model: string,
    request: ClearTableRequest,
    ctx: StudioWriteContext,
  ): Promise<{ deleted: number }>;
  /** Insert `count` synthetic rows derived from column metadata (fk-valid). */
  generateRows?(
    model: string,
    request: GenerateRowsRequest,
    ctx: StudioWriteContext,
  ): Promise<StudioGenerateRowsOutcome>;
}

/**
 * DI token the data ops resolve their source from. Bound by `StudioCrudModule`
 * (crud subpath) or by a BYO source module. Unbound ⇒ the `data` feature reads
 * false and every `data.*` op reports `FEATURE_UNCONFIGURED`.
 */
export const STUDIO_MODEL_SOURCE = new InjectionToken<StudioModelSource>('STUDIO_MODEL_SOURCE');

/** The data panel's settings, provided by the panel that binds the model source. */
export interface StudioDataOptions {
  /**
   * Restrict which discovered models the data browser manages. `include` is an
   * allow-list (only these surface); `exclude` is a deny-list. Each entry
   * matches a model by its qualified identity, name OR table name. Absent ⇒
   * every discovered model is managed.
   */
  managedModels?: { include?: string[]; exclude?: string[] };
  /**
   * Impersonation identity applied to data WRITES, honored only when the
   * `identity` editable gate is open. Server-only; never serialized. See
   * {@link StudioRunAsIdentity}.
   */
  runAsIdentity?: StudioRunAsIdentity;
}

/** The data panel's {@link StudioDataOptions}; absent means every model and no impersonation. */
export const STUDIO_DATA_OPTIONS = new InjectionToken<StudioDataOptions>('STUDIO_DATA_OPTIONS');
