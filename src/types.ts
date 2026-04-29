import type { GuardType } from '@velajs/vela';
import type {
  AdapterBundle,
  EndpointsConfig,
  MetaInput,
} from 'hono-crud';

/**
 * The CRUD operations surfaced by @velajs/crud. Narrower than hono-crud's
 * CrudEndpointName — extension to batch / search / aggregate / etc. is
 * intentionally deferred.
 */
export type CrudEndpointName = 'create' | 'list' | 'read' | 'update' | 'delete';

export const ALL_CRUD_ENDPOINTS: readonly CrudEndpointName[] = [
  'create',
  'list',
  'read',
  'update',
  'delete',
] as const;

/**
 * Per-endpoint config passed through to hono-crud's defineEndpoints. The
 * mapped union of per-endpoint configs has incompatible shapes per key, so
 * each key only accepts the corresponding hono-crud config.
 */
export type EndpointOverride<M extends MetaInput = MetaInput> = {
  create: NonNullable<EndpointsConfig<M>['create']>;
  list: NonNullable<EndpointsConfig<M>['list']>;
  read: NonNullable<EndpointsConfig<M>['read']>;
  update: NonNullable<EndpointsConfig<M>['update']>;
  delete: NonNullable<EndpointsConfig<M>['delete']>;
};

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
}

export interface ResourceConfig<M extends MetaInput = MetaInput>
  extends CrudConfig<M> {
  guards?: GuardType[];
}
