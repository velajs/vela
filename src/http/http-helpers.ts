import type { StorageErrorCode } from '../storage.error';
import type { ByteRange, StoredFile } from '../storage.types';
import type { StorageWireErrorCode } from './protocol.types';

/** Map a core error code to (wire code, HTTP status). */
export function mapError(code: StorageErrorCode): { wire: StorageWireErrorCode; status: number } {
  switch (code) {
    case 'NotFound':
      return { wire: 'not_found', status: 404 };
    case 'AccessDenied':
    case 'ReadOnly':
      return { wire: 'forbidden', status: 403 };
    case 'Unsupported':
      return { wire: 'capability_unsupported', status: 400 };
    case 'InvalidKey':
      return { wire: 'invalid_key', status: 400 };
    case 'InvalidRequest':
    case 'Aborted':
      return { wire: 'invalid_request', status: 400 };
    case 'Conflict':
      return { wire: 'conflict', status: 409 };
    case 'RateLimited':
      return { wire: 'rate_limited', status: 429 };
    case 'Timeout':
      return { wire: 'upstream_error', status: 504 };
    default:
      return { wire: 'upstream_error', status: 502 };
  }
}

export function serializeStored(file: StoredFile) {
  return {
    key: file.key,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    etag: file.etag,
    metadata: file.metadata,
  };
}

export function clampExpiry(requested: number | undefined, def: number, max: number): number {
  return Math.min(requested ?? def, max);
}

/** Parse an HTTP `Range` header (single range) into a {@link ByteRange}. */
export function parseRange(header: string | undefined | null): ByteRange | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] === '' ? undefined : Number(m[2]);
  return { start, end };
}

/** Content-Disposition header — defaults to `attachment` (anti stored-XSS). */
export function dispositionHeader(disposition: string | undefined, name: string): string {
  const filename = `filename*=UTF-8''${encodeURIComponent(name)}`;
  return disposition === 'inline' ? `inline; ${filename}` : `attachment; ${filename}`;
}
