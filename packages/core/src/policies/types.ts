/**
 * Model-level access policies (hono-crud 0.13 parity). Applied uniformly by
 * the engine — list filtering, read 404, write 403, field masking, and
 * WHERE-level pushdown — with no per-endpoint wiring.
 */

import type { FilterCondition } from '../adapter/query-types';

/**
 * Context passed to policy callbacks. Sourced from the in-flight request:
 * `user` from `c.var.user`, tenant/org/user ids from their context vars,
 * `request` from `c.req.raw`.
 */
export interface PolicyContext {
  user?: unknown;
  tenantId?: string;
  organizationId?: string;
  userId?: string;
  request: Request;
}

export interface ModelPolicies<T = unknown> {
  /** Row visibility: false filters the row from lists and 404s point reads. */
  read?: (ctx: PolicyContext, record: T) => boolean | Promise<boolean>;
  /** Write permission: false rejects update/delete/restore with 403. */
  write?: (ctx: PolicyContext, record: T) => boolean | Promise<boolean>;
  /** Field masking: returns the subset of fields this caller may see. */
  fields?: (ctx: PolicyContext, record: T) => Partial<T>;
  /** WHERE-level pushdown merged into every list/read query. */
  readPushdown?: (ctx: PolicyContext) => FilterCondition[];
}
