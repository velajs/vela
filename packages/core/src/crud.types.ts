/**
 * The consumer-facing resource configuration for `@Crud()` and
 * `CrudModule.forFeature()`. Field names stay continuous with the previous
 * bridge where a concept survives (`only`/`except`, `hooks`, `dto`,
 * `responseEnvelope`, `tenantResolverMounted`, `name`/`namePlural`) — that is
 * the surface downstream translators (erpos) emit.
 */

import type { CrudAdapter } from './adapter/contract';
import type { FilterConfig, SortSpec } from './adapter/query-types';
import type { ErrorMapper, ResponseEnvelope } from './envelope/envelope';
import type { CrudHooks, HookModeConfig } from './kernel/hook-types';
import type { ResourceConfig, ResourcePaginationConfig } from './kernel/resource';
import type { Model } from './model/model.types';
import type { VersioningStore } from './versioning/index';
import type { AuditStore } from './audit/index';
import type { CrudEndpointName } from './verb-table';
import type { GuardType } from '@velajs/vela';
import type { Context } from 'hono';
import type { ZodObject, ZodRawShape } from 'zod';

/** Extra invalidation tags / room scoping for a live resource. */
export interface CrudLiveConfig {
  /** Additional tags invalidated alongside `crud:<tableName>`. */
  tags?: (c: Context) => string[];
  /** Scope the invalidation to a room. */
  room?: (c: Context) => string;
}

export interface CrudConfig<Row extends Record<string, unknown> = Record<string, unknown>> {
  /** The normalized model (from `defineModel` / `defineModels`). */
  model: Model;
  /**
   * The data adapter. Optional when `CrudModule.forRoot({ adapter })`
   * provides a default — resolved per request from the DI container.
   */
  adapter?: CrudAdapter<Row>;
  /**
   * Resource name for route names, operationIds, and tags. Defaults to
   * `model.name`; `namePlural` defaults to `model.namePlural`.
   */
  name?: string;
  namePlural?: string;
  /** Verb selection: `only` wins over `except`; model gates always apply. */
  only?: readonly CrudEndpointName[];
  except?: readonly CrudEndpointName[];
  /**
   * Per-endpoint HTTP guards — stamped onto each synthesized handler exactly
   * like a hand-written `@UseGuards` on that method, so they run after global
   * and class-level guards (AND). Guards keyed to a disabled verb are inert;
   * `@Override`'d endpoints keep their config guards alongside their own.
   * Programmatic `resource.execute` dispatch bypasses HTTP guards by design.
   */
  guards?: Partial<Record<CrudEndpointName, GuardType[]>>;
  hooks?: CrudHooks<Row> & HookModeConfig;
  filterFields?: string[];
  filterConfig?: FilterConfig;
  sortFields?: string[];
  defaultSort?: SortSpec;
  searchFields?: string[];
  allowedIncludes?: string[];
  fieldSelection?: ResourceConfig<Row>['fieldSelection'];
  pagination?: ResourcePaginationConfig;
  /** Insert-or-update conflict target for the upsert family. */
  upsert?: ResourceConfig<Row>['upsert'];
  /** Source fields cleared before a clone insert (model/db defaults reapply). */
  clone?: ResourceConfig<Row>['clone'];
  /** Batch verb limits. */
  batch?: ResourceConfig<Row>['batch'];
  /** Filtered bulk patch limits + confirmation threshold. */
  bulkPatch?: ResourceConfig<Row>['bulkPatch'];
  /** /search weighted-field configuration (falls back to `searchFields`). */
  search?: ResourceConfig<Row>['search'];
  /** /aggregate validation configuration. */
  aggregate?: ResourceConfig<Row>['aggregate'];
  /** Request-body schema overrides (else derived from the model schema). */
  dto?: { create?: ZodObject<ZodRawShape>; update?: ZodObject<ZodRawShape> };
  updateFields?: { allowed?: string[]; blocked?: string[] };
  /**
   * Version-history store (REQUIRED when `model.versioning` is on). Falls back
   * to the `CrudModule.forRoot({ versioningStore })` default when omitted.
   */
  versioningStore?: VersioningStore;
  /**
   * Audit-log store (REQUIRED when `model.audit` is on). Falls back to the
   * `CrudModule.forRoot({ auditStore })` default when omitted.
   */
  auditStore?: AuditStore;
  /** Pluggable response envelope (default: `{ success, result[, result_info] }`). */
  responseEnvelope?: ResponseEnvelope;
  errorMappers?: ErrorMapper[];
  /** OpenAPI tags (defaults to the plural resource name). */
  tags?: string[];
  /**
   * Live-query invalidation: after a successful write, invalidate
   * `crud:<tableName>` (+ configured extras) and stamp the commit headers
   * (requires `@velajs/vela/live`'s LiveModule; degrades to a warning).
   */
  live?: boolean | CrudLiveConfig;
  /**
   * Affirms that a tenant resolver is mounted upstream for this tenant-scoped
   * model. Mounting a tenant-scoped resource without one silently loses
   * tenant isolation — a data-loss class — so decoration fails fast instead.
   */
  tenantResolverMounted?: boolean;
}

/**
 * Thrown at decoration/definition time when a tenant-scoped model is mounted
 * without affirming `tenantResolverMounted: true` (previous-bridge parity —
 * same class name and fields).
 */
export class MissingTenantResolverError extends Error {
  override readonly name = 'MissingTenantResolverError';
  /** The controller path / feature path the resource is mounted at. */
  readonly mountPath: string;
  /** The `Model.tableName` of the tenant-scoped resource. */
  readonly tableName: string;

  constructor(opts: { mountPath: string; tableName: string }) {
    super(
      `CRUD resource at '${opts.mountPath}' uses the tenant-scoped model '${opts.tableName}' ` +
        `but no tenant resolver is affirmed. Mount your tenant-resolution middleware upstream ` +
        `and set 'tenantResolverMounted: true' on the resource config — without it every row ` +
        `read or written silently ignores tenant isolation.`,
    );
    this.mountPath = opts.mountPath;
    this.tableName = opts.tableName;
  }
}

/** Resolved singular/plural naming for a resource config. */
export function resourceNames(config: Pick<CrudConfig, 'model' | 'name' | 'namePlural'>): {
  singular: string;
  plural: string;
} {
  const singular = config.name ?? config.model.name;
  // When `name` is overridden without `namePlural`, pluralize the override
  // naively (previous-bridge behavior) instead of using the model plural.
  const plural =
    config.namePlural ?? (config.name !== undefined ? `${singular}s` : config.model.namePlural);
  return { singular, plural };
}
