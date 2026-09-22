import {
  ReliabilityError,
  type ReliabilityScope,
  type WorkRecord,
  type WorkKind,
  type WorkState,
  type Lease,
} from './types';

// oxlint-disable-next-line eslint/no-control-regex -- Reject control characters in persisted identifiers and canonical JSON.
const CONTROL_CHARACTERS = /[\u0000-\u001f]/u;
export const MAX_BYTES = 1_048_576;
export const DEFAULT_BYTES = 65_536;
export const MAX_TIME = 8_640_000_000_000_000;
export const MAX_DURATION = 31_536_000_000;
export function invalid(message: string): never {
  throw new ReliabilityError('INVALID_INPUT', message);
}
export function text(value: unknown, name: string, max = 1024): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    CONTROL_CHARACTERS.test(value)
  )
    invalid(`Invalid ${name}`);
  return value;
}
export function integer(value: unknown, name: string, min = 0, max = MAX_TIME): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(`Invalid ${name}`);
  return value;
}
export function scope(value: ReliabilityScope): ReliabilityScope {
  if (!value || typeof value !== 'object') invalid('Expected a tenant namespace');
  return Object.freeze({
    tenantId: text(value.tenantId, 'tenantId'),
    namespace: text(value.namespace, 'namespace', 256),
  });
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return Object.fromEntries(Object.entries(value));
}
/** Bounded canonical JSON: no cycles, accessors, class instances, nonfinite numbers or coercion. */
export function encodeJson(value: unknown, maxBytes = DEFAULT_BYTES): string {
  integer(maxBytes, 'JSON byte limit', 1, MAX_BYTES);
  const encoder = new TextEncoder();
  let size = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const add = (part: string): string => {
    size += encoder.encode(part).byteLength;
    if (size > maxBytes) invalid('JSON byte limit exceeded');
    return part;
  };
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 32) invalid('JSON complexity limit exceeded');
    if (input === null) return add('null');
    if (typeof input === 'boolean') return add(String(input));
    if (typeof input === 'number' && Number.isFinite(input)) return add(JSON.stringify(input));
    if (typeof input === 'string') {
      if (input.length > maxBytes) invalid('JSON byte limit exceeded');
      return add(JSON.stringify(input));
    }
    if (typeof input !== 'object' || input === null) invalid('Expected a JSON value');
    if (seen.has(input)) invalid('Cyclic JSON value');
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      invalid('Expected a plain JSON object');
    seen.add(input);
    let result: string;
    if (Array.isArray(input)) {
      if (input.length > 100_000) invalid('JSON complexity limit exceeded');
      result = add('[');
      for (let i = 0; i < input.length; i++) {
        const property = Object.getOwnPropertyDescriptor(input, String(i));
        if (!property || !('value' in property))
          invalid('Sparse arrays and accessors are not JSON values');
        result += (i ? add(',') : '') + visit(property.value, depth + 1);
      }
      result += add(']');
    } else {
      const keys = Object.keys(input).toSorted();
      result = add('{');
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const property = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in property)) invalid('JSON accessors are unsupported');
        result +=
          (i ? add(',') : '') +
          add(JSON.stringify(key)) +
          add(':') +
          visit(property.value, depth + 1);
      }
      result += add('}');
    }
    seen.delete(input);
    return result;
  };
  return visit(value, 0);
}
export function decodeJson(value: string, maxBytes = DEFAULT_BYTES): unknown {
  if (
    typeof value !== 'string' ||
    value.length > maxBytes ||
    new TextEncoder().encode(value).byteLength > maxBytes
  )
    invalid('Stored JSON byte limit exceeded');
  const parsed: unknown = JSON.parse(value);
  encodeJson(parsed, maxBytes);
  return parsed;
}
export async function fingerprint(value: unknown, maxBytes = DEFAULT_BYTES): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(encodeJson(value, maxBytes)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function validateLease(value: Lease, kind?: WorkKind): void {
  scope(value);
  text(value.id, 'lease id');
  text(value.generation, 'generation', 128);
  text(value.token, 'lease token', 128);
  if (
    !['idempotency', 'outbox', 'inbox', 'job'].includes(value.kind) ||
    (kind && value.kind !== kind)
  )
    invalid('Invalid lease kind');
  integer(value.fence, 'fence', 1, Number.MAX_SAFE_INTEGER);
  integer(value.attempt, 'attempt', 1, 1000);
  integer(value.leaseUntil, 'lease expiry');
}
export function decodeRecord(value: unknown): WorkRecord {
  const row = object(value);
  const kind = row.kind;
  const state = row.state;
  if (kind !== 'idempotency' && kind !== 'outbox' && kind !== 'inbox' && kind !== 'job')
    invalid('Invalid stored kind');
  if (
    state !== 'pending' &&
    state !== 'leased' &&
    state !== 'completed' &&
    state !== 'failed' &&
    state !== 'cancelled'
  )
    invalid('Invalid stored state');
  const nullableTime = (key: string): number | null =>
    row[key] === null ? null : integer(row[key], key);
  const nullableText = (key: string, limit: number): string | null =>
    row[key] === null ? null : text(row[key], key, limit);
  const record = {
    tenantId: text(row.tenantId, 'tenantId'),
    namespace: text(row.namespace, 'namespace', 256),
    kind: kind as WorkKind,
    id: text(row.id, 'id'),
    generation: text(row.generation, 'generation', 128),
    fingerprint: text(row.fingerprint, 'fingerprint', 256),
    payload: text(row.payload, 'payload', MAX_BYTES),
    state: state as WorkState,
    token: nullableText('token', 128),
    fence: integer(row.fence, 'fence', 0, Number.MAX_SAFE_INTEGER),
    revision: integer(row.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    attempt: integer(row.attempt, 'attempt', 0, 1000),
    maxAttempts: integer(row.maxAttempts, 'maxAttempts', 1, 1000),
    availableAt: integer(row.availableAt, 'availableAt'),
    leaseUntil: nullableTime('leaseUntil'),
    createdAt: integer(row.createdAt, 'createdAt'),
    updatedAt: integer(row.updatedAt, 'updatedAt'),
    retentionMs: integer(row.retentionMs, 'retentionMs', 1, MAX_DURATION),
    expiresAt: nullableTime('expiresAt'),
    result: nullableText('result', MAX_BYTES),
    error: nullableText('error', 512),
  };
  if (
    record.attempt > record.maxAttempts ||
    (record.state === 'leased' && (!record.token || record.leaseUntil === null || !record.fence))
  )
    invalid('Invalid stored lease');
  decodeJson(record.payload, MAX_BYTES);
  if (record.result !== null) decodeJson(record.result, MAX_BYTES);
  return Object.freeze(record);
}
