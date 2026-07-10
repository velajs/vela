/**
 * Canonical CRUD route table — ported verbatim from hono-crud 0.13
 * (`core/crud-routes.ts`), the single source of truth for every endpoint the
 * engine can expose: `[name, HTTP verb, sub-path]`.
 *
 * REGISTRATION ORDER INVARIANTS — array order IS stamping order:
 *
 * 1. Collection routes (`create`, `list`) come first.
 * 2. Batch and named sub-routes (`/batch*`, `/search`, `/aggregate`,
 *    `/export`, `/import`, `/upsert`, `/bulk`) MUST be stamped BEFORE the
 *    `:id` item routes, so e.g. `/batch` is not matched as an id parameter.
 * 3. `:id` item routes and their sub-routes (`/restore`, `/clone`) follow.
 * 4. `/versions/compare` MUST come BEFORE `/versions/:version` so "compare"
 *    isn't matched as a version id.
 */

import type { Model } from './model/model.types';

export const CRUD_ROUTES = [
  // Collection-level routes (no :id parameter)
  ['create', 'post', ''],
  ['list', 'get', ''],
  // Batch routes — before :id routes so '/batch' is not matched as an id
  ['batchCreate', 'post', '/batch'],
  ['batchUpdate', 'patch', '/batch'],
  ['batchDelete', 'delete', '/batch'],
  ['batchRestore', 'post', '/batch/restore'],
  ['batchUpsert', 'post', '/batch/upsert'],
  // Named collection sub-routes — before :id routes
  ['search', 'get', '/search'],
  ['aggregate', 'get', '/aggregate'],
  ['export', 'get', '/export'],
  ['import', 'post', '/import'],
  ['upsert', 'post', '/upsert'],
  // Bulk-patch (collection-level) — before :id so '/bulk' is not an id
  ['bulkPatch', 'patch', '/bulk'],
  // Item-level routes (with :id parameter)
  ['read', 'get', '/:id'],
  ['update', 'patch', '/:id'],
  ['delete', 'delete', '/:id'],
  ['restore', 'post', '/:id/restore'],
  ['clone', 'post', '/:id/clone'],
  // Version sub-resource routes — '/versions/compare' before '/versions/:version'
  ['versionHistory', 'get', '/:id/versions'],
  ['versionCompare', 'get', '/:id/versions/compare'],
  ['versionRead', 'get', '/:id/versions/:version'],
  ['versionRollback', 'post', '/:id/versions/:version/rollback'],
] as const satisfies ReadonlyArray<
  readonly [string, 'get' | 'post' | 'put' | 'patch' | 'delete', string]
>;

/** Every endpoint name, derived from the table so the union cannot drift. */
export type CrudEndpointName = (typeof CRUD_ROUTES)[number][0];

export const ALL_CRUD_ENDPOINTS: readonly CrudEndpointName[] = CRUD_ROUTES.map(
  ([name]) => name,
);

/** Version verbs are gated behind `model.versioning`. */
export const VERSION_ENDPOINTS: readonly CrudEndpointName[] = [
  'versionHistory',
  'versionCompare',
  'versionRead',
  'versionRollback',
];

/** Restore verbs are gated behind soft delete. */
const RESTORE_ENDPOINTS: readonly CrudEndpointName[] = ['restore', 'batchRestore'];

export interface EndpointSelection {
  only?: readonly CrudEndpointName[];
  except?: readonly CrudEndpointName[];
}

/**
 * Resolves the verb set for a resource: `only` wins over `except`; model
 * gates (versioning, soft delete) filter what the model can't support.
 * Returns names in TABLE ORDER regardless of `only` order — stamping order is
 * a routing invariant, not a preference.
 */
export function resolveEnabledEndpoints(
  model: Pick<Model, 'versioning' | 'softDeleteField'>,
  selection: EndpointSelection = {},
): CrudEndpointName[] {
  const requested = new Set<CrudEndpointName>(
    selection.only ?? ALL_CRUD_ENDPOINTS.filter((name) => !selection.except?.includes(name)),
  );
  return ALL_CRUD_ENDPOINTS.filter((name) => {
    if (!requested.has(name)) return false;
    if (VERSION_ENDPOINTS.includes(name) && !model.versioning) return false;
    if (RESTORE_ENDPOINTS.includes(name) && model.softDeleteField === undefined) return false;
    return true;
  });
}
