import type { GuardType } from '@velajs/vela';
import type {
  AdapterBundle,
  EndpointsConfig,
  MetaInput,
} from 'hono-crud';
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * The CRUD operations surfaced by @velajs/crud. Mirrors hono-crud's
 * CrudEndpointName so the bridge forwards the full surface — search,
 * aggregate, restore, batch ops, export/import, upsert, clone.
 *
 * Versioning verbs (versionHistory/Read/Compare/Rollback) are still
 * deferred until a real consumer exercises them.
 */
export type CrudEndpointName =
  | 'create'
  | 'list'
  | 'read'
  | 'update'
  | 'delete'
  | 'search'
  | 'aggregate'
  | 'restore'
  | 'batchCreate'
  | 'batchUpdate'
  | 'batchDelete'
  | 'batchRestore'
  | 'batchUpsert'
  | 'export'
  | 'import'
  | 'upsert'
  | 'clone';

export const ALL_CRUD_ENDPOINTS: readonly CrudEndpointName[] = [
  'create',
  'list',
  'read',
  'update',
  'delete',
  'search',
  'aggregate',
  'restore',
  'batchCreate',
  'batchUpdate',
  'batchDelete',
  'batchRestore',
  'batchUpsert',
  'export',
  'import',
  'upsert',
  'clone',
] as const;

/**
 * Per-endpoint override forwarded to hono-crud's EndpointsConfig<M> slot.
 * Each key references the matching hono-crud config-API type; the cast at
 * builder.ts:128 unifies the narrow per-key shape into EndpointsConfig<M>
 * before handing it to defineEndpoints(...).
 */
export type EndpointOverride<M extends MetaInput = MetaInput> = {
  create: NonNullable<EndpointsConfig<M>['create']>;
  list: NonNullable<EndpointsConfig<M>['list']>;
  read: NonNullable<EndpointsConfig<M>['read']>;
  update: NonNullable<EndpointsConfig<M>['update']>;
  delete: NonNullable<EndpointsConfig<M>['delete']>;
  search: NonNullable<EndpointsConfig<M>['search']>;
  aggregate: NonNullable<EndpointsConfig<M>['aggregate']>;
  restore: NonNullable<EndpointsConfig<M>['restore']>;
  batchCreate: NonNullable<EndpointsConfig<M>['batchCreate']>;
  batchUpdate: NonNullable<EndpointsConfig<M>['batchUpdate']>;
  batchDelete: NonNullable<EndpointsConfig<M>['batchDelete']>;
  batchRestore: NonNullable<EndpointsConfig<M>['batchRestore']>;
  batchUpsert: NonNullable<EndpointsConfig<M>['batchUpsert']>;
  export: NonNullable<EndpointsConfig<M>['export']>;
  import: NonNullable<EndpointsConfig<M>['import']>;
  upsert: NonNullable<EndpointsConfig<M>['upsert']>;
  clone: NonNullable<EndpointsConfig<M>['clone']>;
};

/**
 * Per-route Zod schema overrides for request bodies. Each key, when set,
 * is forwarded to hono-crud as `endpoints.{name}.bodySchema` (added in
 * hono-crud 0.5.0): the route validates against the user's schema instead
 * of the model-derived default. The schema is used as-is — primary keys,
 * multi-tenant fields, and `.partial()` are NOT applied automatically.
 */
export interface CrudDtos {
  create?: ZodObject<ZodRawShape>;
  update?: ZodObject<ZodRawShape>;
}

/**
 * Flat ergonomic sugar over `endpoints.{name}.hooks.{before,after}`.
 * Specifying both is allowed — the flat form runs first, then the per-endpoint
 * one (last-write-wins is hono-crud's behavior internally).
 */
export interface CrudHooks {
  beforeCreate?: (data: unknown) => unknown | Promise<unknown>;
  afterCreate?: (data: unknown) => unknown | Promise<unknown>;
  beforeList?: () => void | Promise<void>;
  afterList?: (items: unknown[]) => unknown[] | Promise<unknown[]>;
  beforeRead?: (lookupValue: string) => void | Promise<void>;
  afterRead?: (data: unknown) => unknown | Promise<unknown>;
  beforeUpdate?: (data: unknown) => unknown | Promise<unknown>;
  afterUpdate?: (data: unknown) => unknown | Promise<unknown>;
  beforeDelete?: (lookupValue: string) => void | Promise<void>;
  afterDelete?: (lookupValue: string) => void | Promise<void>;
}

export interface CrudConfig<M extends MetaInput = MetaInput> {
  /** Model meta from `defineMeta({ model })`. */
  meta: M;
  /** Adapter bundle (e.g. MemoryAdapters, DrizzleAdapters). */
  adapters: AdapterBundle;
  /** Include only these CRUD operations. */
  only?: CrudEndpointName[];
  /** Exclude these CRUD operations. */
  except?: CrudEndpointName[];
  /** Per-endpoint config passed through to hono-crud's defineEndpoints. */
  endpoints?: { [K in CrudEndpointName]?: EndpointOverride<M>[K] };
  /** Flat before/after hooks per route. Sugar over endpoints.{name}.hooks. */
  hooks?: CrudHooks;
  /** Per-route Zod schema overrides for create / update body validation. */
  dto?: CrudDtos;
}

export interface ResourceConfig<M extends MetaInput = MetaInput>
  extends CrudConfig<M> {
  guards?: GuardType[];
}
