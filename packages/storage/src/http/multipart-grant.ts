import { base64ToBytes, bytesToBase64Url } from '../base64';
import { StorageError } from '../storage.error';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MIN_SECRET_BYTES = 32;

export interface MultipartGrantClaims {
  v: 2;
  actorId: string;
  key: string;
  /** Provider key used until the completed object has passed server-side validation. */
  stagingKey: string;
  uploadId: string;
  expectedBytes: number;
  partCount: number;
  expiresAtMs: number;
}

function invalidGrant(): StorageError {
  return new StorageError('AccessDenied', 'invalid or expired multipart upload grant');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidGrant();
  const padding = (4 - (value.length % 4)) % 4;
  try {
    return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  } catch {
    throw invalidGrant();
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseClaims(value: unknown): MultipartGrantClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidGrant();
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'v',
    'actorId',
    'key',
    'stagingKey',
    'uploadId',
    'expectedBytes',
    'partCount',
    'expiresAtMs',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw invalidGrant();
  if (
    record.v !== 2 ||
    typeof record.actorId !== 'string' ||
    record.actorId.length === 0 ||
    typeof record.key !== 'string' ||
    record.key.length === 0 ||
    typeof record.stagingKey !== 'string' ||
    record.stagingKey.length === 0 ||
    typeof record.uploadId !== 'string' ||
    record.uploadId.length === 0 ||
    !isPositiveSafeInteger(record.expectedBytes) ||
    !isPositiveSafeInteger(record.partCount) ||
    !isPositiveSafeInteger(record.expiresAtMs)
  ) {
    throw invalidGrant();
  }
  return {
    v: 2,
    actorId: record.actorId,
    key: record.key,
    stagingKey: record.stagingKey,
    uploadId: record.uploadId,
    expectedBytes: record.expectedBytes,
    partCount: record.partCount,
    expiresAtMs: record.expiresAtMs,
  };
}

function secretBytes(secret: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = typeof secret === 'string' ? encoder.encode(secret) : new Uint8Array(secret);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new StorageError(
      'InvalidRequest',
      `multipartGrantSecret must contain at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Validate grant configuration before a provider-side multipart upload is allocated. */
export function validateMultipartGrantSecret(secret: string | Uint8Array): void {
  secretBytes(secret);
}

async function hmac(secret: string | Uint8Array, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

export async function createMultipartGrant(
  secret: string | Uint8Array,
  claims: MultipartGrantClaims,
): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = bytesToBase64Url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

export async function verifyMultipartGrant(
  secret: string | Uint8Array,
  token: string,
): Promise<MultipartGrantClaims> {
  if (typeof token !== 'string' || token.length > 4096) throw invalidGrant();
  const segments = token.split('.');
  if (segments.length !== 2) throw invalidGrant();
  const payload = segments[0]!;
  const supplied = decodeBase64Url(segments[1]!);
  const expected = await hmac(secret, payload);
  if (supplied.byteLength !== expected.byteLength) throw invalidGrant();
  let mismatch = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    mismatch |= supplied[index]! ^ expected[index]!;
  }
  if (mismatch !== 0) throw invalidGrant();

  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(decodeBase64Url(payload))) as unknown;
  } catch {
    throw invalidGrant();
  }
  const claims = parseClaims(decoded);
  if (claims.expiresAtMs <= Date.now()) throw invalidGrant();
  return claims;
}
