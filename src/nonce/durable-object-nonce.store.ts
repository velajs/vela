import { DurableObject } from 'cloudflare:workers';
import type { NonceStore } from '@velajs/vela';

const APP_NAMESPACE_PREFIX = 'vela:nonce:v1:';
const MAX_APP_NAMESPACE_BYTES = 128;
const MAX_NONCE_BYTES = 512;
const EXPIRED_DELETE_BATCH = 1_024;
const encoder = new TextEncoder();

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

/** The generated Workers binding type for {@link VelaNonceDurableObject}. */
export type DurableObjectNonceNamespace = DurableObjectNamespace<VelaNonceDurableObject>;

export interface DurableObjectNonceStoreOptions {
  /**
   * Stable application/environment boundary (for example `billing-api:prod`).
   * Claims are globally single-use inside this namespace and isolated from all
   * other application namespaces. It must be non-empty, canonical, and at most
   * 128 UTF-8 bytes.
   */
  appNamespace: string;

  /**
   * Resolve the Workers Durable Object namespace at claim time. The resolver is
   * intentionally not cached so request-scoped env/binding references stay safe.
   */
  binding: () => DurableObjectNonceNamespace | Promise<DurableObjectNonceNamespace>;
}

function isCanonicalBoundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff))
    ) {
      return false;
    }
  }
  return value.length > 0 && value === value.trim() && encoder.encode(value).byteLength <= maxBytes;
}

function isValidExpiry(
  expEpochSeconds: unknown,
  nowEpochSeconds: number,
): expEpochSeconds is number {
  return (
    typeof expEpochSeconds === 'number' &&
    Number.isSafeInteger(expEpochSeconds) &&
    expEpochSeconds > 0 &&
    expEpochSeconds >= nowEpochSeconds
  );
}

function isNamespace(value: unknown): value is DurableObjectNonceNamespace {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.idFromName === 'function' && typeof candidate.get === 'function';
}

/**
 * Strict, cross-isolate {@link NonceStore} backed by one SQLite Durable Object
 * per explicit application namespace.
 *
 * Invalid input, an unavailable/malformed binding, RPC failure, or a malformed
 * RPC result all deny the claim (`false`). Only the literal boolean `true` from
 * the Durable Object is accepted.
 */
export function durableObjectNonceStore(options: DurableObjectNonceStoreOptions): NonceStore {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Durable Object nonce-store options are required');
  }
  if (!isCanonicalBoundedText(options.appNamespace, MAX_APP_NAMESPACE_BYTES)) {
    throw new TypeError(
      `appNamespace must be canonical, non-empty, and at most ${MAX_APP_NAMESPACE_BYTES} UTF-8 bytes`,
    );
  }
  if (typeof options.binding !== 'function') {
    throw new TypeError('A lazy Durable Object namespace binding resolver is required');
  }

  const objectName = `${APP_NAMESPACE_PREFIX}${options.appNamespace}`;

  return {
    async claim(nonce: string, expEpochSeconds: number): Promise<boolean> {
      const now = Math.floor(Date.now() / 1_000);
      if (!isCanonicalBoundedText(nonce, MAX_NONCE_BYTES) || !isValidExpiry(expEpochSeconds, now)) {
        return false;
      }

      try {
        const namespace = await options.binding();
        if (!isNamespace(namespace)) return false;

        const id = namespace.idFromName(objectName);
        const stub = namespace.get(id) as unknown as {
          claim?: (value: string, expiry: number) => unknown;
        };
        if (!stub || typeof stub.claim !== 'function') return false;

        const result = await stub.claim(nonce, expEpochSeconds);
        return result === true;
      } catch {
        return false;
      }
    },
  };
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
      const sql = ctx.storage?.sql as NonceSqlStorage | undefined;
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
      const record = row as Record<string, unknown>;
      if (
        !Object.prototype.hasOwnProperty.call(record, 'nonce') ||
        !Object.prototype.hasOwnProperty.call(record, 'expires_at')
      ) {
        return false;
      }
      return record.nonce === nonce && record.expires_at === expEpochSeconds;
    } catch {
      return false;
    }
  }
}
