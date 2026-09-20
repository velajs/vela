import { DurableObject } from 'cloudflare:workers';
import { MAX_NONCE_BYTES, isCanonicalBoundedText, isValidExpiry } from './nonce-validation';
const EXPIRED_DELETE_BATCH = 1_024;

const CREATE_TABLE =
  'CREATE TABLE IF NOT EXISTS __vela_nonce_claims (' +
  'nonce TEXT PRIMARY KEY NOT NULL, ' +
  'expires_at INTEGER NOT NULL CHECK (expires_at > 0)' +
  ') WITHOUT ROWID';
const CREATE_EXPIRY_INDEX =
  'CREATE INDEX IF NOT EXISTS __vela_nonce_claims_expiry ON __vela_nonce_claims (expires_at)';
const DELETE_EXPIRED =
  'DELETE FROM __vela_nonce_claims WHERE nonce IN (' +
  'SELECT nonce FROM __vela_nonce_claims ' +
  'WHERE expires_at < ? ORDER BY expires_at LIMIT ?' +
  ')';
const INSERT_CLAIM =
  'INSERT INTO __vela_nonce_claims (nonce, expires_at) VALUES (?, ?) ' +
  'ON CONFLICT(nonce) DO NOTHING RETURNING nonce, expires_at';

interface NonceSqlCursor {
  toArray(): Record<string, unknown>[];
}

interface NonceSqlStorage {
  exec(query: string, ...bindings: unknown[]): NonceSqlCursor;
}

/**
 * SQLite Durable Object that atomically consumes nonces.
 *
 * Export this class from the Worker entry and register it through a Wrangler
 * `new_sqlite_classes` migration. `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 * is the single-use decision; all SQL runs synchronously before the RPC method
 * yields, and the nonce primary key is the final concurrency boundary.
 */
export class VelaNonceDurableObject extends DurableObject<Record<string, unknown>> {
  private sql?: NonceSqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    try {
      const sql = ctx.storage?.sql;
      if (!sql || typeof sql.exec !== 'function') return;
      sql.exec(CREATE_TABLE);
      sql.exec(CREATE_EXPIRY_INDEX);
      this.sql = sql;
    } catch {
      // A non-SQLite/misconfigured class stays fail-closed: every claim denies.
      this.sql = undefined;
    }
  }

  async claim(nonce: string, expEpochSeconds: number): Promise<boolean> {
    const sql = this.sql;
    if (!sql) return false;

    const now = Math.floor(Date.now() / 1_000);
    if (!isCanonicalBoundedText(nonce, MAX_NONCE_BYTES) || !isValidExpiry(expEpochSeconds, now)) {
      return false;
    }

    try {
      // Keep cleanup bounded so one claim cannot monopolize the DO. Entries at
      // exactly `now` remain: Vela's invocation verifier accepts `now === exp`.
      sql.exec(DELETE_EXPIRED, now, EXPIRED_DELETE_BATCH);

      const cursor = sql.exec(INSERT_CLAIM, nonce, expEpochSeconds);
      if (!cursor || typeof cursor.toArray !== 'function') return false;
      const rows: unknown = cursor.toArray();
      if (!Array.isArray(rows) || rows.length !== 1) return false;

      const row: unknown = rows[0];
      if (typeof row !== 'object' || row === null) return false;
      if (
        !Object.hasOwn(row, 'nonce') ||
        !Object.hasOwn(row, 'expires_at') ||
        !('nonce' in row) ||
        !('expires_at' in row)
      ) {
        return false;
      }
      return row.nonce === nonce && row.expires_at === expEpochSeconds;
    } catch {
      return false;
    }
  }
}
