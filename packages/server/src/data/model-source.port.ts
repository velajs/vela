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
  FacetsRequest,
  FacetsResponse,
  ListRowsRequest,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioRowPage,
} from '@velajs/studio-protocol';

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
}

/**
 * DI token the data ops resolve their source from. Bound by `StudioCrudModule`
 * (crud subpath) or by a BYO source module. Unbound ⇒ the `data` feature reads
 * false and every `data.*` op reports `FEATURE_UNCONFIGURED`.
 */
export const STUDIO_MODEL_SOURCE = new InjectionToken<StudioModelSource>('STUDIO_MODEL_SOURCE');
