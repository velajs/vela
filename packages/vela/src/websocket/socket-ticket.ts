// Short-lived, room-bound WebSocket upgrade tickets. The token is deliberately
// self-contained and edge-safe: Web Crypto HMAC, Uint8Array, and base64url only.
// It never depends on Node APIs and shares Vela's single HMAC implementation.

import { fromBase64Url, importHmacKey, toBase64Url } from '../crypto/hmac';
import type { NonceStore } from '../dispatch/types';
import { assertWebSocketRoomId } from './gateway-routing';

/** Audience domain separator; socket tickets cannot be replayed as other Vela tokens. */
export const WEBSOCKET_TICKET_AUDIENCE = 'vela:websocket' as const;
/** Fixed purpose within the WebSocket audience. */
export const WEBSOCKET_TICKET_PURPOSE = 'socket-ticket' as const;
/** Socket credentials are intentionally very short-lived. */
export const WEBSOCKET_TICKET_MAX_TTL_MS = 30_000;

const DEFAULT_TTL_MS = WEBSOCKET_TICKET_MAX_TTL_MS;
const MAX_SECRET_BYTES = 4_096;
const MAX_CLAIM_BYTES = 4_096;
const MAX_TOKEN_CHARS = 6_000;
const MAX_GATEWAY_PATH_BYTES = 1_024;
const MAX_ISSUER_BYTES = 512;
const MAX_SUBJECT_BYTES = 512;
const MAX_TENANT_ID_BYTES = 512;
const MAX_NONCE_BYTES = 128;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const CLAIM_KEYS = [
  'aud',
  'purpose',
  'gatewayPath',
  'room',
  'principal',
  'tenantId',
  'issuedAtMs',
  'expiresAtMs',
  'nonce',
] as const;
const PRINCIPAL_KEYS = ['issuer', 'subject', 'principalType'] as const;

/** Canonical principal carried by an authenticated socket. */
export type WebSocketTicketPrincipalType = 'user' | 'service';

export interface WebSocketTicketPrincipal {
  issuer: string;
  subject: string;
  principalType: WebSocketTicketPrincipalType;
}

/** Exact signed claim persisted into connection state after successful consumption. */
export interface WebSocketTicketClaim {
  aud: typeof WEBSOCKET_TICKET_AUDIENCE;
  purpose: typeof WEBSOCKET_TICKET_PURPOSE;
  gatewayPath: string;
  room: string;
  principal: WebSocketTicketPrincipal;
  tenantId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
}

/** A structural alias: Vela's MemoryNonceStore and distributed stores both satisfy it. */
export type WebSocketTicketNonceStore = Pick<NonceStore, 'claim'>;

export interface IssueWebSocketTicketOptions {
  secret: string;
  gatewayPath: string;
  room: string;
  principal: WebSocketTicketPrincipal;
  tenantId: string;
  /** Positive lifetime in milliseconds; defaults to and may not exceed 30 seconds. */
  ttlMs?: number;
  /** Deterministic clock override for tests. */
  nowMs?: number;
}

export interface VerifyWebSocketTicketOptions {
  secret: string;
  /** Declared gateway path expected by the accepting route. */
  gatewayPath: string;
  /** Resolved room expected by the accepting route. */
  room: string;
  /** Must atomically return false for an already-consumed nonce. */
  nonceStore: WebSocketTicketNonceStore;
  /** Deterministic clock override for tests. */
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isBoundedCanonicalString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !CONTROL_CHARACTER_RE.test(value) &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

function isSecret(value: unknown): value is string {
  return isBoundedCanonicalString(value, MAX_SECRET_BYTES);
}

function isGatewayPath(value: unknown): value is string {
  if (
    !isBoundedCanonicalString(value, MAX_GATEWAY_PATH_BYTES) ||
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    /%(?![0-9A-Fa-f]{2})/.test(value)
  ) {
    return false;
  }
  try {
    return new URL(value, 'https://vela.invalid').pathname === value;
  } catch {
    return false;
  }
}

function isRoom(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    assertWebSocketRoomId(value);
    return true;
  } catch {
    return false;
  }
}

function isPrincipal(value: unknown): value is WebSocketTicketPrincipal {
  if (!isRecord(value) || !hasExactOwnKeys(value, PRINCIPAL_KEYS)) return false;
  return (
    isBoundedCanonicalString(value.issuer, MAX_ISSUER_BYTES) &&
    isBoundedCanonicalString(value.subject, MAX_SUBJECT_BYTES) &&
    (value.principalType === 'user' || value.principalType === 'service')
  );
}

function isSafeEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isClaim(value: unknown): value is WebSocketTicketClaim {
  if (!isRecord(value) || !hasExactOwnKeys(value, CLAIM_KEYS)) return false;
  if (
    value.aud !== WEBSOCKET_TICKET_AUDIENCE ||
    value.purpose !== WEBSOCKET_TICKET_PURPOSE ||
    !isGatewayPath(value.gatewayPath) ||
    !isRoom(value.room) ||
    !isPrincipal(value.principal) ||
    !isBoundedCanonicalString(value.tenantId, MAX_TENANT_ID_BYTES) ||
    !isSafeEpochMs(value.issuedAtMs) ||
    !isSafeEpochMs(value.expiresAtMs) ||
    !isBoundedCanonicalString(value.nonce, MAX_NONCE_BYTES)
  ) {
    return false;
  }
  const lifetime = value.expiresAtMs - value.issuedAtMs;
  return lifetime > 0 && lifetime <= WEBSOCKET_TICKET_MAX_TTL_MS;
}

function decodeCanonicalBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) return null;
  try {
    const bytes = fromBase64Url(value);
    return toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function resolveIssueTime(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!isSafeEpochMs(now)) throw new TypeError('WebSocket ticket nowMs must be a safe epoch value');
  return now;
}

/**
 * Issue a 30-second-or-shorter HMAC credential bound to one gateway and room.
 * The nonce is always generated by Web Crypto; callers cannot accidentally
 * choose or reuse it.
 */
export async function issueWebSocketTicket(options: IssueWebSocketTicketOptions): Promise<string> {
  if (!isSecret(options.secret)) {
    throw new TypeError('WebSocket ticket secret must be a non-empty bounded string');
  }
  if (!isGatewayPath(options.gatewayPath)) {
    throw new TypeError('WebSocket ticket gatewayPath must be a canonical absolute path');
  }
  if (!isRoom(options.room)) throw new TypeError('WebSocket ticket room is invalid');
  if (!isPrincipal(options.principal)) {
    throw new TypeError('WebSocket ticket principal must use the canonical principal schema');
  }
  if (!isBoundedCanonicalString(options.tenantId, MAX_TENANT_ID_BYTES)) {
    throw new TypeError('WebSocket ticket tenantId must be a non-empty bounded string');
  }

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > WEBSOCKET_TICKET_MAX_TTL_MS) {
    throw new TypeError('WebSocket ticket ttlMs must be between 1 and 30000');
  }
  const issuedAtMs = resolveIssueTime(options.nowMs);
  const expiresAtMs = issuedAtMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError('WebSocket ticket expiry exceeds the safe integer range');
  }

  const claim: WebSocketTicketClaim = {
    aud: WEBSOCKET_TICKET_AUDIENCE,
    purpose: WEBSOCKET_TICKET_PURPOSE,
    gatewayPath: options.gatewayPath,
    room: options.room,
    principal: {
      issuer: options.principal.issuer,
      subject: options.principal.subject,
      principalType: options.principal.principalType,
    },
    tenantId: options.tenantId,
    issuedAtMs,
    expiresAtMs,
    nonce: crypto.randomUUID(),
  };
  const claimBytes = encoder.encode(JSON.stringify(claim));
  if (claimBytes.byteLength > MAX_CLAIM_BYTES) {
    throw new TypeError('WebSocket ticket claim exceeds the maximum encoded size');
  }
  const claimPart = toBase64Url(claimBytes);
  const key = await importHmacKey(options.secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(claimPart));
  const token = `${claimPart}.${toBase64Url(signature)}`;
  if (token.length > MAX_TOKEN_CHARS) {
    throw new TypeError('WebSocket ticket exceeds the maximum encoded size');
  }
  return token;
}

/**
 * Verify all ticket bindings and atomically consume its nonce. Every untrusted
 * failure—including malformed input, bad signatures, expiry, binding mismatch,
 * replay, or store failure—returns `false` without throwing.
 */
export async function verifyAndConsumeWebSocketTicket(
  token: unknown,
  options: VerifyWebSocketTicketOptions,
): Promise<WebSocketTicketClaim | false> {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_CHARS ||
    !isSecret(options.secret) ||
    !isGatewayPath(options.gatewayPath) ||
    !isRoom(options.room) ||
    typeof options.nonceStore?.claim !== 'function'
  ) {
    return false;
  }

  const separator = token.indexOf('.');
  if (separator <= 0 || separator !== token.lastIndexOf('.') || separator >= token.length - 1) {
    return false;
  }
  const claimPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  const claimBytes = decodeCanonicalBase64Url(claimPart);
  const signature = decodeCanonicalBase64Url(signaturePart);
  if (
    claimBytes === null ||
    claimBytes.byteLength > MAX_CLAIM_BYTES ||
    signature === null ||
    signature.byteLength !== 32
  ) {
    return false;
  }

  try {
    const key = await importHmacKey(options.secret);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(claimPart));
    if (!valid) return false;
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(claimBytes)) as unknown;
  } catch {
    return false;
  }
  if (!isClaim(parsed)) return false;

  const nowMs = options.nowMs ?? Date.now();
  if (
    !isSafeEpochMs(nowMs) ||
    parsed.issuedAtMs > nowMs ||
    nowMs >= parsed.expiresAtMs ||
    parsed.gatewayPath !== options.gatewayPath ||
    parsed.room !== options.room
  ) {
    return false;
  }

  try {
    const claimed = await options.nonceStore.claim(
      parsed.nonce,
      Math.ceil(parsed.expiresAtMs / 1_000),
    );
    return claimed === true ? parsed : false;
  } catch {
    return false;
  }
}
