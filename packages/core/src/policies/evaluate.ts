/**
 * Pure policy evaluators over {@link ModelPolicies} (hono-crud 0.13 parity).
 *
 * These are side-effect-free primitives: they NEVER throw and NEVER mutate the
 * engine's response — they only compute "can this actor see/write this row?"
 * and "what does the row look like after masking?". The kernel composes them
 * and decides the HTTP consequence, exactly mirroring hono-crud's
 * `CrudEndpoint` policy region (see `endpoints/base.ts`):
 *
 *   - LIST  rows failing `read` are FILTERED silently ({@link filterReadable}).
 *   - READ  a point read failing `read` returns `false` from {@link canRead};
 *           the kernel throws `NotFoundException` (404 — never leak existence).
 *   - WRITE update/delete/restore failing `write` returns `false` from
 *           {@link canWrite}; the kernel throws `ForbiddenException` (403).
 *   - MASK  `fields` is applied by {@link maskFields} after a row is deemed
 *           readable (identity when no mask is configured).
 *   - PUSHDOWN `readPushdown` conditions are surfaced by
 *           {@link pushdownConditions} for the kernel to AND into the adapter
 *           query so denied rows never leave the database.
 *
 * The read filter and the field mask are deliberately ORTHOGONAL primitives
 * (hono-crud fused them inside `applyReadPolicyToArray`). The kernel is
 * responsible for composing them for lists — `filterReadable(...)` then map
 * each survivor through `maskFields(...)` — and for point reads —
 * `canRead(...)` → 404, then `maskFields(...)`.
 */

import type { FilterCondition } from '../adapter/query-types';
import type { ModelPolicies, PolicyContext } from './types';

/**
 * Whether a single record is readable by the current actor. `true` when no
 * `read` predicate is configured (open by default). Async predicates are
 * awaited; the result is coerced to a strict boolean. Point-read callers turn
 * `false` into a 404 so existence is not leaked; list callers drop the row.
 */
export async function canRead<T>(
  ctx: PolicyContext,
  record: T,
  policies?: ModelPolicies<T>,
): Promise<boolean> {
  if (!policies?.read) return true;
  return Boolean(await policies.read(ctx, record));
}

/**
 * Whether the current actor may write (update/delete/restore) a record.
 * `true` when no `write` predicate is configured. Async predicates are
 * awaited and coerced to a strict boolean. Callers turn `false` into a 403.
 */
export async function canWrite<T>(
  ctx: PolicyContext,
  record: T,
  policies?: ModelPolicies<T>,
): Promise<boolean> {
  if (!policies?.write) return true;
  return Boolean(await policies.write(ctx, record));
}

/**
 * Filter a list of rows down to the ones the `read` predicate permits,
 * preserving order. No-op (returns the input array reference) when no `read`
 * predicate is configured. Rows are evaluated sequentially so an async
 * predicate observes a deterministic order and a throwing predicate aborts the
 * whole list (propagating to the kernel) rather than partially filtering.
 *
 * Masking is NOT applied here — compose with {@link maskFields} per survivor.
 */
export async function filterReadable<T>(
  ctx: PolicyContext,
  rows: T[],
  policies?: ModelPolicies<T>,
): Promise<T[]> {
  if (!policies?.read) return rows;
  const out: T[] = [];
  for (const row of rows) {
    if (await canRead(ctx, row, policies)) out.push(row);
  }
  return out;
}

/**
 * Apply the `fields` mask to a record when configured; identity otherwise.
 * The mask is a shallow overlay (`{ ...record, ...fields(ctx, record) }`),
 * matching hono-crud — the predicate returns the subset of fields to REPLACE
 * (e.g. redacted values), not the fields to keep. Synchronous, mirroring the
 * `ModelPolicies.fields` contract (a sync `(ctx, record) => Partial<T>`).
 */
export function maskFields<T>(
  ctx: PolicyContext,
  record: T,
  policies?: ModelPolicies<T>,
): T {
  if (!policies?.fields) return record;
  const mask = policies.fields(ctx, record);
  return {
    ...(record as Record<string, unknown>),
    ...(mask as Record<string, unknown>),
  } as T;
}

/**
 * The `readPushdown` filter conditions for the current actor, or `[]` when no
 * pushdown is configured. The kernel ANDs these into every list/read adapter
 * query so rows the policy would strip post-fetch are never returned by the
 * database in the first place.
 */
export function pushdownConditions<T>(
  ctx: PolicyContext,
  policies?: ModelPolicies<T>,
): FilterCondition[] {
  if (!policies?.readPushdown) return [];
  return policies.readPushdown(ctx) ?? [];
}
