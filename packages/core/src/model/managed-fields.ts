/**
 * Engine-managed write-time fields: primary-key generation (`Model.id`), the
 * tenant column, and auto-managed timestamps (`Model.timestamps`).
 *
 * SINGLE source of truth for PK-resolution precedence, timestamp stamping, and
 * the input-schema exclusion set. Every adapter routes every write through
 * these helpers so the precedence is never copy-pasted. Consumes the
 * NORMALIZED {@link Model} (defaults already resolved by `defineModel`).
 *
 * Parity note vs hono-crud 0.13 (`core/managed-fields.ts`):
 *  - `id:'database'` is gated by the adapter's `databaseGeneratedId`
 *    CAPABILITY (`opts.databaseGeneratedId`) instead of a hardcoded
 *    `adapter === 'memory'` check.
 *  - the tenant field is folded into {@link getManagedInputExclusions} here
 *    (hono-crud added it separately in the create endpoint).
 */

import { ConfigurationException, InputValidationException } from '../envelope/errors';
import type { IdStrategy, Model } from './model.types';

/** Fields the engine owns on writes — stripped from model-derived input schemas. */
export function getManagedInputExclusions(
  model: Pick<Model, 'id' | 'timestamps' | 'primaryKeys' | 'tenantField'>,
  options: { includePrimaryKeys?: boolean } = {},
): string[] {
  const { includePrimaryKeys = true } = options;
  const exclude = new Set<string>();

  // Primary keys are engine/DB-generated (uuid / custom fn / database), so a
  // client must never be forced to supply them on create — EXCEPT under
  // id: 'client', where the caller-supplied PK stays in the create schema
  // (this single gate flows to static derivation, the resolveSchema
  // re-derive, and the OpenAPI DTO).
  if (includePrimaryKeys && model.id !== 'client') {
    for (const pk of model.primaryKeys) exclude.add(pk);
  }

  // Timestamps are stamped at every write site (createdAt + updatedAt on
  // insert, updatedAt always on update) — resolve the (possibly renamed) field
  // names from the normalized config, never hardcode them.
  if (model.timestamps.createdAt) exclude.add(model.timestamps.createdAt);
  if (model.timestamps.updatedAt) exclude.add(model.timestamps.updatedAt);

  // The tenant column is injected automatically from request context.
  if (model.tenantField) exclude.add(model.tenantField);

  return [...exclude];
}

/** Treat `null`, `undefined` and `''` as "the caller did not supply a PK". */
function pkSupplied(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Resolve the engine-managed write-time fields for a single INSERT record.
 *
 * Applies, in order:
 *  1. Primary-key strategy ({@link Model.id}) on `primaryKeys[0]`:
 *     - caller-supplied non-empty PK wins, untouched;
 *     - `function` ⇒ call it;
 *     - `'database'` ⇒ DELETE the PK so the DB/ORM default fills it — but
 *       throws a {@link ConfigurationException} when the adapter cannot
 *       generate keys (`opts.databaseGeneratedId === false`);
 *     - `'client'` ⇒ the caller owns generation; a missing PK throws an
 *       {@link InputValidationException} (400 — missing input, not misconfig);
 *     - else (`'uuid'` or unset) ⇒ `crypto.randomUUID()`.
 *  2. Timestamps ({@link Model.timestamps}) when enabled: set the configured
 *     `createdAt` / `updatedAt` columns to `Date.now()` unless the caller
 *     explicitly supplied that field.
 *
 * Returns a NEW object — the input is never mutated.
 */
export function applyManagedInsertFields<T extends Record<string, unknown>>(
  model: Pick<Model, 'id' | 'timestamps' | 'primaryKeys'>,
  record: T,
  opts: { databaseGeneratedId: boolean },
): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  const pk = model.primaryKeys[0];

  if (!pkSupplied(out[pk])) {
    const strategy: IdStrategy = model.id;
    if (typeof strategy === 'function') {
      out[pk] = strategy();
    } else if (strategy === 'database') {
      if (!opts.databaseGeneratedId) {
        throw new ConfigurationException(
          "id:'database' requires an adapter with the 'databaseGeneratedId' capability (no database to generate the key)",
        );
      }
      // Omit the PK entirely: the DB/ORM column default fills it and the
      // adapter reads the generated value back via its create-return.
      delete out[pk];
    } else if (strategy === 'client') {
      // The caller owns PK generation; reaching here means none was supplied.
      // The derived create schema keeps the PK, so a required PK 400s at
      // validation — this seam catches optional-PK schemas and clone-without-
      // override, which are caller input errors, not misconfiguration.
      throw new InputValidationException(
        "id:'client' requires a caller-supplied primary key in the create body",
      );
    } else {
      // 'uuid' or unset — the historical default.
      out[pk] = crypto.randomUUID();
    }
  }

  const { createdAt, updatedAt } = model.timestamps;
  const now = Date.now();
  if (createdAt && !(createdAt in record)) out[createdAt] = now;
  if (updatedAt && !(updatedAt in record)) out[updatedAt] = now;

  return out as T & Record<string, unknown>;
}

/**
 * Resolve the engine-managed write-time fields for an UPDATE payload.
 *
 * When the `updatedAt` timestamp is configured, ALWAYS sets it to `Date.now()`
 * — a server-managed column, so any client-supplied value is ignored.
 * `createdAt` is never touched on update. A NEW object is always returned so
 * callers never mutate their input.
 */
export function applyManagedUpdateFields<T extends Record<string, unknown>>(
  model: Pick<Model, 'timestamps'>,
  patch: T,
): T & Record<string, unknown> {
  const { updatedAt } = model.timestamps;
  if (!updatedAt) return { ...patch };
  return { ...patch, [updatedAt]: Date.now() };
}
