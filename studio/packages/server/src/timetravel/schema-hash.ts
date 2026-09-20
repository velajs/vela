/**
 * Stable schema hashing for snapshot compatibility checks. A snapshot records a
 * `schemaHash` per table at capture time; a restore compares it against the
 * model's CURRENT hash so a column added/removed/retyped since the snapshot is
 * caught (`schemaCompatible: false` → 409 `TIMETRAVEL_SCHEMA_MISMATCH`).
 *
 * Computed in-package with Web Crypto (`crypto.subtle.digest` via the shared
 * {@link sha256}) over a canonical, order-independent signature of the model's
 * columns — NO sibling dependency (the `@velajs/errors` `sha256Hex` re-export is
 * a separate M11 item). The signature intentionally captures only structural
 * shape (name/type/pk/nullable/unique/fk/managed), never row data, so two models
 * with identical schemas hash identically regardless of column declaration order.
 */
import type { StudioColumn } from '@velajs/studio-protocol';
import { base64UrlEncode, canonicalJson, sha256, utf8 } from '../security/crypto';

/** One column reduced to its schema-significant fields, for hashing. */
interface ColumnSignature {
  name: string;
  type: StudioColumn['type'];
  pk: boolean;
  nullable: boolean;
  unique: boolean;
  managed: boolean;
  fk: { table: string; relation: string } | null;
}

/** Reduce a column to its order-independent signature. */
function signatureOf(column: StudioColumn): ColumnSignature {
  return {
    name: column.name,
    type: column.type,
    pk: column.pk,
    nullable: column.nullable,
    unique: column.unique,
    managed: column.managed,
    fk: column.fk ?? null,
  };
}

/**
 * A stable, URL-safe base64 SHA-256 over the model's column signatures. Columns
 * are sorted by name so declaration order never changes the hash;
 * {@link canonicalJson} sorts object keys recursively so field order is stable too.
 */
export async function schemaHashForColumns(columns: readonly StudioColumn[]): Promise<string> {
  const signature = columns
    .map(signatureOf)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return base64UrlEncode(await sha256(utf8(canonicalJson(signature))));
}

/**
 * A combined hash over every table's `schemaHash` (table name + hash pairs,
 * sorted), used as the snapshot mark's single `schemaHash`. Purely informational
 * — per-table compatibility is decided from the per-table hashes in the manifest.
 */
export async function combinedSchemaHash(
  tables: ReadonlyArray<{ table: string; schemaHash: string }>,
): Promise<string> {
  const pairs = tables
    .map((t) => [t.table, t.schemaHash] as const)
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return base64UrlEncode(await sha256(utf8(canonicalJson(pairs))));
}
