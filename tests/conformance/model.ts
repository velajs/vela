/**
 * The shared conformance model, ported to the native @velajs/crud engine.
 *
 * Canonical fields (identical names + semantics to the hono-crud spec):
 *   id        — uuid primary key, library-generated
 *   name      — non-empty string
 *   email     — unique in SQL backends (the memory adapter has no constraint
 *               surface — see the `uniqueConstraints` capability)
 *   role      — 'admin' | 'user' | 'guest', defaults to 'user'
 *   age       — nullable int
 *   deletedAt — nullable soft-delete marker (`softDelete: { field: 'deletedAt' }`)
 *   createdAt / updatedAt — library-managed epoch-ms timestamps
 *
 * The list config (filterConfig + sortFields) is the operator allow-list the
 * filter-operators / pagination cells depend on; it is the SAME set the
 * hono-crud conformance app configured on its `/items` list endpoint.
 */
import { defineModel } from '@velajs/crud';
import type { FilterConfig } from '@velajs/crud/adapter';
import { z } from 'zod';
import { type ConformanceApp, type ConformanceRecord, createRecord } from './contract';

export const CONFORMANCE_ROLES = ['admin', 'user', 'guest'] as const;

/** Physical table name backing the memory store. */
export const CONFORMANCE_TABLE = 'conformance_items';

/**
 * The conformance schema: library-managed epoch-ms timestamps (numbers).
 * `id`/`createdAt`/`updatedAt` are engine-owned on writes and stripped from the
 * derived create/update body schemas.
 */
export const conformanceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  email: z.email(),
  role: z.enum(CONFORMANCE_ROLES).default('user'),
  age: z.number().int().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export const conformanceModel = defineModel({
  name: 'item',
  tableName: CONFORMANCE_TABLE,
  schema: conformanceSchema,
  primaryKeys: ['id'],
  softDelete: { field: 'deletedAt' },
  timestamps: true,
});

// ============================================================================
// Multi-tenant model variant (tenant-scoping + relation-scoping cells)
// ============================================================================

/** Physical table for the tenant-scoped `/tenant-items` route family. */
export const CONFORMANCE_TENANT_TABLE = 'conformance_tenant_items';

/**
 * The tenant schema: the shared conformance fields plus a nullable `tenantId`
 * discriminator (so serialized rows carry it) and a nullable `parentId` FK for
 * the owner-scoped self-relation the relation-scoping cell exercises. Both are
 * engine-managed/optional on input (`tenantId` is stamped from context;
 * `parentId` is an ordinary optional column).
 */
export const tenantSchema = conformanceSchema.extend({
  tenantId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export const tenantModel = defineModel({
  name: 'tenantItem',
  tableName: CONFORMANCE_TENANT_TABLE,
  schema: tenantSchema,
  primaryKeys: ['id'],
  softDelete: { field: 'deletedAt' },
  timestamps: true,
  // Tenant field defaults to 'tenantId'; @Crud demands tenantResolverMounted.
  multiTenant: true,
  relations: {
    // Owner-scoped self-relation: a row's `parent` is filtered to the caller's
    // tenant (the engine passes the RelationLoadScope {tenantField, tenantValue}
    // to the loader). Soft-delete exclusion of the parent is NOT yet wired —
    // see the relation-scoping cell's PARITY-GAP skip.
    parent: {
      type: 'belongsTo',
      target: CONFORMANCE_TENANT_TABLE,
      foreignKey: 'parentId',
      localKey: 'id',
    },
  },
});

/**
 * Operators every adapter must accept on the list endpoint. The filter cells
 * exercise exactly these.
 */
export const CONFORMANCE_FILTER_CONFIG: FilterConfig = {
  role: ['eq', 'ne', 'in'],
  age: ['eq', 'gt', 'gte', 'lt', 'lte'],
  name: ['like', 'ilike'],
};

/** Sortable fields exposed on the list endpoint. */
export const CONFORMANCE_SORT_FIELDS = ['email'];

export interface ConformanceSeedRow {
  name: string;
  email: string;
  role: (typeof CONFORMANCE_ROLES)[number];
  age: number;
}

/**
 * Fixed dataset for the filter matrix and pagination cells.
 *
 * Deliberate properties:
 * - 'Alice Anderson' vs 'alice cooper': pins `like` case-sensitivity and
 *   `ilike` case-insensitivity.
 * - 'Carol 100% Pure' vs 'Dave 100 Wool': pins that user-supplied `%` is
 *   inert (stripped, never a wildcard) and `_` is literal.
 * - Emails sort deterministically: alice < bob < carol < cooper < dave.
 */
export const FILTER_SEED: readonly ConformanceSeedRow[] = [
  { name: 'Alice Anderson', email: 'alice@conformance.test', role: 'admin', age: 35 },
  { name: 'alice cooper', email: 'cooper@conformance.test', role: 'user', age: 28 },
  { name: 'Bob Brown', email: 'bob@conformance.test', role: 'user', age: 22 },
  { name: 'Carol 100% Pure', email: 'carol@conformance.test', role: 'guest', age: 40 },
  { name: 'Dave 100 Wool', email: 'dave@conformance.test', role: 'guest', age: 50 },
];

/** Emails of FILTER_SEED in ascending order (pagination walk expectation). */
export const SEED_EMAILS_SORTED: readonly string[] = [...FILTER_SEED]
  .map((row) => row.email)
  .sort();

/** Creates all FILTER_SEED rows through the real create endpoint. */
export async function seedFilterRows(
  app: ConformanceApp,
  basePath: string,
): Promise<Map<string, ConformanceRecord>> {
  const byEmail = new Map<string, ConformanceRecord>();
  for (const row of FILTER_SEED) {
    const created = await createRecord(app, basePath, { ...row });
    byEmail.set(row.email, created);
  }
  return byEmail;
}
