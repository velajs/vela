/**
 * @velajs/crud-drizzle — Drizzle ORM CrudAdapter (sqlite, pg, mysql) plus
 * Drizzle-backed versioning/audit stores.
 */

export { drizzleAdapter, type DrizzleAdapterConfig, type DrizzleRelation } from './adapter';
export { DrizzleAuditStore, DrizzleVersioningStore } from './stores';
export type { DrizzleDialect, DrizzleTable } from './database';
export { buildWhere, buildWhereCondition, substringMatch } from './filters';
