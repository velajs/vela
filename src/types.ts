import type { GuardType } from '@velajs/vela';
import type { HookContext, MetaInput, ResponseEnvelope } from 'hono-crud';
import type { AdapterBundle, EndpointsConfig } from 'hono-crud/config';
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * The CRUD operations surfaced by @velajs/crud. Mirrors hono-crud's
 * CrudEndpointName so the bridge forwards the full surface — search,
 * aggregate, restore, batch ops, export/import, upsert, clone, and
 * bulk-patch (PATCH a filtered set at the collection level).
 *
 * Versioning verbs (versionHistory/Read/Compare/Rollback) are the only
 * hono-crud verbs still deferred until a real consumer exercises them.
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
  | 'clone'
  | 'bulkPatch';

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
  'bulkPatch',
] as const;

/**
 * Maps a bridge endpoint verb to the PascalCase adapter slot name hono-crud
 * looks up on the AdapterBundle (e.g. `'batchCreate'` → `'BatchCreateEndpoint'`).
 * Mirrors hono-crud's internal verb→slot table; verified against `AdapterBundle`
 * (hono-crud/config) and `@hono-crud/memory`'s `MemoryAdapters`.
 */
export function crudEndpointSlot(name: CrudEndpointName): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}Endpoint`;
}

/**
 * Returns `true` when the given adapter bundle ships the base class for `name`.
 * Detects by runtime key presence on the bundle object — hono-crud 0.13's
 * `AdapterBundle` is a plain record of `${Verb}Endpoint` constructors, with the
 * five base verbs required and the rest optional. We read only public keys, so
 * this does not couple to hono-crud internals. Slot values are class
 * constructors (truthy when present), so the `!= null` presence test agrees
 * with hono-crud's own falsy `if (!slot)` guard at its throw site.
 */
export function adapterProvidesEndpoint(
  adapters: unknown,
  name: CrudEndpointName,
): boolean {
  if (!adapters || typeof adapters !== 'object') return false;
  const slot = crudEndpointSlot(name);
  return (adapters as Record<string, unknown>)[slot] != null;
}

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
  bulkPatch: NonNullable<EndpointsConfig<M>['bulkPatch']>;
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
 * Flat-sugar hooks fired by @velajs/crud. Each handler receives a
 * HookContext (transaction handle, tenantId, organizationId, userId,
 * agentId, agentRunId) as the first argument; remaining arguments are
 * the data shape(s) relevant to the hook.
 *
 * `afterUpdate` and `afterDelete` mirror hono-crud's two-snapshot shape:
 * the bridge surface receives the **pre-mutation** row as `prior` and,
 * for updates, the **post-mutation** row as `current` — both observed
 * inside the same DB transaction as the parent write (when the adapter
 * wraps in one). The two-snapshot shape lets downstream consumers
 * compute field-level diffs server-side (audit logs, CDC payloads,
 * event bodies) without a re-fetch.
 *
 * The bridge translates each flat hook into hono-crud's per-endpoint
 * shape inside `builder.ts:mergeFlatHooks` — for `afterUpdate` and
 * `afterDelete` that means flipping `(ctx, prior, current?)` here into
 * hono-crud's `(prior, current?, ctx)`. Per-endpoint hooks attached
 * via `endpoints.{name}.hooks` win over flat sugar (existing
 * precedence preserved).
 */
export interface CrudHooks {
  beforeCreate?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>;
  afterCreate?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>;
  beforeList?: (ctx: HookContext) => void | Promise<void>;
  afterList?: (ctx: HookContext, items: unknown[]) => unknown[] | Promise<unknown[]>;
  beforeRead?: (ctx: HookContext, lookupValue: string) => void | Promise<void>;
  afterRead?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>;
  beforeUpdate?: (ctx: HookContext, data: unknown) => unknown | Promise<unknown>;
  afterUpdate?: (
    ctx: HookContext,
    prior: unknown,
    current: unknown,
  ) => unknown | Promise<unknown>;
  beforeDelete?: (ctx: HookContext, lookupValue: string) => void | Promise<void>;
  afterDelete?: (ctx: HookContext, prior: unknown) => void | Promise<void>;
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
  /**
   * Pluggable response envelope forwarded verbatim to hono-crud's
   * `RegisterCrudOptions.responseEnvelope`. When set, both functions are
   * the **final formatting step** before each response body is
   * serialised — `success(result, info?)` for every 2xx and
   * `error(structuredError)` for every error response (composed after
   * any `ErrorMapper`s registered on `createErrorHandler`).
   *
   * Default behaviour (omit this option) is byte-identical to
   * hono-crud's pre-0.10.0 shape — `{ success: true, result, result_info? }`
   * for success and `{ success: false, error: <StructuredError> }` for
   * errors. Each `forResource` / `defineCrudResource` / `@Crud` mount
   * carries its own envelope, so different resources can ship different
   * envelopes if needed.
   *
   * @example
   * ```ts
   * CrudModule.forResource('/posts', {
   *   meta, adapters,
   *   responseEnvelope: {
   *     success: (result, info) => info ? { data: result, meta: info } : { data: result },
   *     error:   (err) => ({ error: { code: err.code, message: err.message } }),
   *   },
   * });
   * ```
   */
  responseEnvelope?: ResponseEnvelope;
  /**
   * Affirm that a tenant resolver (e.g. hono-crud's `multiTenant()`
   * middleware, or any equivalent that calls `c.set('tenantId', ...)`) is
   * mounted on the parent Hono app upstream of this resource.
   *
   * **Default `false`.** When the resolved `Model` is tenant-scoped — i.e.
   * `Model.multiTenant === true | MultiTenantConfig`, or
   * `Model.policies?.readPushdown` is set — and this flag is not `true`,
   * `@velajs/crud` throws {@link MissingTenantResolverError} synchronously
   * at module-load time.
   *
   * Why: `HookContext.tenantId` and `CrudEventPayload.tenantId` propagate
   * only when something upstream resolves the tenant. Without that
   * resolver, hooks, audit logs, events, and CDC consumers silently see
   * `tenantId: undefined` for tenant-scoped data — a data-loss bug class
   * (see CHANGELOG `[0.6.0]` for the canonical wiring pattern).
   *
   * Set this flag once you have verified that `multiTenant()` (or your
   * own equivalent) is mounted before this resource. The flag is an
   * affirmation, not a probe — `@velajs/crud` cannot introspect Hono's
   * middleware stack at module-load time, so the bridge trusts the
   * caller's affirmation and fails fast in its absence.
   *
   * @example
   * ```ts
   * // Parent app wires the resolver upstream:
   * import { multiTenant } from 'hono-crud';
   * app.use('/*', multiTenant());
   *
   * // Bridge config affirms the wiring:
   * CrudModule.forResource('/posts', {
   *   meta: postMeta,             // Model.multiTenant: true
   *   adapters: drizzleAdapters,
   *   tenantResolverMounted: true,
   * });
   * ```
   */
  tenantResolverMounted?: boolean;
}

export interface ResourceConfig<M extends MetaInput = MetaInput>
  extends CrudConfig<M> {
  guards?: GuardType[];
}

/**
 * Thrown synchronously at module-load when a tenant-scoped {@link Model}
 * is mounted via `CrudModule.forResource(...)` (or `defineCrudResource(...)`,
 * or `@Crud(...)`) without the caller affirming that a tenant resolver is
 * wired upstream via `tenantResolverMounted: true`.
 *
 * **Why this exists.** A `Model` declares tenant scope when its
 * `multiTenant` field is set (`true` or a `MultiTenantConfig`), or when
 * its `policies.readPushdown` is configured. If no upstream middleware
 * resolves the tenant before requests reach this resource,
 * `HookContext.tenantId` and `CrudEventPayload.tenantId` propagate as
 * `undefined` — silent tenant attribution loss for hooks, audit logs,
 * events, and CDC consumers. That is a data-loss bug class, not a
 * recoverable runtime error. The bridge fails fast at compose-time so
 * the misconfiguration cannot ship.
 *
 * **Recovering.** Either:
 *   1. Mount `multiTenant()` (or your own equivalent that calls
 *      `c.set('tenantId', ...)`) on the parent app *before* the resource
 *      is mounted, and set `tenantResolverMounted: true` on the bridge
 *      config.
 *   2. If the model genuinely should not be tenant-scoped, remove
 *      `multiTenant` (and any `policies.readPushdown`) from the model.
 *
 * Caught by consumers who want to surface a custom load-time message:
 * ```ts
 * import { MissingTenantResolverError } from '@velajs/crud';
 * try { CrudModule.forResource(...); }
 * catch (e) { if (e instanceof MissingTenantResolverError) { ... } }
 * ```
 */
export class MissingTenantResolverError extends Error {
  override readonly name = 'MissingTenantResolverError';
  /** The mount path passed to `forResource` / `defineCrudResource` / `@Crud`. */
  readonly mountPath: string;
  /** The `Model.tableName` of the tenant-scoped resource. */
  readonly tableName: string;

  constructor(opts: { mountPath: string; tableName: string }) {
    super(buildMissingTenantResolverMessage(opts));
    this.mountPath = opts.mountPath;
    this.tableName = opts.tableName;
  }
}

function buildMissingTenantResolverMessage(opts: {
  mountPath: string;
  tableName: string;
}): string {
  const { mountPath, tableName } = opts;
  return [
    `@velajs/crud: tenant-scoped Model '${tableName}' is mounted at '${mountPath}'`,
    `but no tenant resolver was affirmed on the bridge config.`,
    ``,
    `Without an upstream tenant resolver, HookContext.tenantId and`,
    `CrudEventPayload.tenantId silently propagate as 'undefined' — a`,
    `data-loss bug class for hooks, audit logs, events, and CDC consumers.`,
    `See CHANGELOG [0.6.0] for the parent-app middleware pattern.`,
    ``,
    `Fix: mount a tenant resolver upstream and affirm it on the config:`,
    ``,
    `    import { multiTenant } from 'hono-crud';`,
    `    app.use('/*', multiTenant());`,
    ``,
    `    CrudModule.forResource('${mountPath}', {`,
    `      meta, adapters,`,
    `      tenantResolverMounted: true,`,
    `    });`,
    ``,
    `If the Model genuinely should not be tenant-scoped, remove`,
    `'multiTenant' (and any 'policies.readPushdown') from the Model definition.`,
  ].join('\n');
}

/**
 * Returns `true` if the given `MetaInput.model` declares tenant scope —
 * i.e. it has `multiTenant: true | MultiTenantConfig`, or it sets
 * `policies.readPushdown` (the documented signal that pushdown filtering
 * is tenant-aware in hono-crud's policy surface).
 */
export function isTenantScopedMeta(meta: MetaInput): boolean {
  // Cast through `unknown` because `MetaInput`'s `model` is generic over a
  // ZodObject; the runtime fields we read are stable across instantiations.
  const model = (meta as unknown as { model?: Record<string, unknown> })?.model;
  if (!model) return false;
  const mt = model.multiTenant;
  if (mt === true) return true;
  if (mt && typeof mt === 'object') return true;
  const policies = model.policies as { readPushdown?: unknown } | undefined;
  if (policies && typeof policies.readPushdown === 'function') return true;
  return false;
}

/**
 * Throws {@link MissingTenantResolverError} when the model is tenant-scoped
 * and the caller did not affirm `tenantResolverMounted: true`. No-op for
 * non-tenant-scoped models or when the affirmation is present.
 */
export function assertTenantResolverMounted(opts: {
  meta: MetaInput;
  mountPath: string;
  tenantResolverMounted: boolean | undefined;
}): void {
  if (opts.tenantResolverMounted === true) return;
  if (!isTenantScopedMeta(opts.meta)) return;
  const tableName =
    ((opts.meta as unknown as { model?: { tableName?: string } })?.model?.tableName) ??
    '<unknown>';
  throw new MissingTenantResolverError({ mountPath: opts.mountPath, tableName });
}
