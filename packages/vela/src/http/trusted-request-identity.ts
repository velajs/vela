import type { ExecutionContext } from '../pipeline/types';
import { RequestContextKey } from './request-context';

/** Canonical principal published only after server-side credential verification. */
export interface TrustedRequestPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly principalType: 'user' | 'service';
}

/** One authentication authority for guards, throttling and request parameters. */
export interface TrustedRequestIdentity {
  readonly principal: TrustedRequestPrincipal;
  readonly tenantId?: string;
  /** Exclusive credential expiry, in epoch milliseconds. */
  readonly expiresAtMs?: number;
  /** Explicitly granted application roles, never unmapped external groups. */
  readonly roles?: readonly string[];
  /** Verified claims; publication snapshots and recursively freezes JSON values. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

const MAX_IDENTITY_COMPONENT_LENGTH = 256;
// One record per authentication generation. Only tenant admission may update
// its snapshot; ordinary publication replaces the record and its attachments.
interface AuthenticationState {
  identity: TrustedRequestIdentity;
}
const identityByRequest = new WeakMap<Request, AuthenticationState>();
const identityEncoder = new TextEncoder();
const requestByContext = new WeakMap<ExecutionContext, Request>();

/**
 * A trusted HTTP adapter may bind a custom execution context (for example one
 * GraphQL field) to its original request. This does not authenticate the request
 * or copy authority. Bind once before dispatch; rebinding is rejected.
 */
export function bindTrustedRequestContext(context: ExecutionContext, request: Request): void {
  const existing = requestByContext.get(context);
  if (
    context.getType() === 'ws' ||
    context.getRequest() !== request ||
    (existing && existing !== request)
  ) {
    throw new TypeError('[vela] invalid HTTP-backed execution context');
  }
  requestByContext.set(context, request);
}

/** HTTP requests and explicitly bound adapters only; no implicit transport inheritance. */
export function getTrustedContextRequest(context: ExecutionContext): Request | undefined {
  return context.getType() === 'http' ? context.getRequest() : requestByContext.get(context);
}

function readData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError(`[vela] trusted request identity ${key} must be an own data property`);
  }
  const field: unknown = descriptor.value;
  return field;
}

function component(value: unknown, key: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    identityEncoder.encode(value).byteLength > MAX_IDENTITY_COMPONENT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new TypeError(`[vela] trusted request identity ${key} is invalid`);
  return value;
}

/** Claims cross a JSON boundary; reject executable/accessor/cyclic values. */
function snapshot(value: unknown, ancestors: Set<object>, depth = 0): unknown {
  if (depth > 64) throw new TypeError('[vela] trusted identity claims are too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new TypeError('[vela] trusted identity claims must be JSON values');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) =>
          snapshot(readData(value, String(index)), ancestors, depth + 1),
        ),
      );
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError('[vela] trusted identity claims must be plain objects');
    }
    const entries = Object.keys(value).map(
      (key) => [key, snapshot(readData(value, key), ancestors, depth + 1)] as const,
    );
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

function snapshotClaims(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('[vela] trusted identity claims must be an object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('[vela] trusted identity claims must be plain objects');
  }
  const entries = Object.keys(value).map(
    (key) => [key, snapshot(readData(value, key), new Set([value]))] as const,
  );
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Publish verified state. Only trusted authentication middleware/guards may call
 * this capability after verifying credentials and tenant membership. A failed
 * publication clears old state just like an explicit authentication rejection.
 */
export function setTrustedRequestIdentity(
  request: Request,
  identity: TrustedRequestIdentity,
): void {
  identityByRequest.delete(request);
  if (typeof identity !== 'object' || identity === null) {
    throw new TypeError('[vela] trusted request identity must be an object');
  }
  const principal = readData(identity, 'principal');
  if (typeof principal !== 'object' || principal === null) {
    throw new TypeError('[vela] trusted request identity principal must be an own data property');
  }
  const issuer = component(readData(principal, 'issuer'), 'issuer');
  const subject = component(readData(principal, 'subject'), 'subject');
  const principalType = readData(principal, 'principalType');
  if (principalType !== 'user' && principalType !== 'service') {
    throw new TypeError('[vela] trusted request identity principalType is invalid');
  }
  const tenant = readData(identity, 'tenantId');
  const tenantId = tenant === undefined ? undefined : component(tenant, 'tenantId');
  const expiresAtMs = readData(identity, 'expiresAtMs');
  if (
    expiresAtMs !== undefined &&
    (typeof expiresAtMs !== 'number' ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= Date.now())
  )
    throw new TypeError('[vela] trusted request identity expiresAtMs is invalid or expired');
  const roleInput = readData(identity, 'roles');
  let roles: readonly string[] | undefined;
  if (roleInput !== undefined) {
    if (!Array.isArray(roleInput))
      throw new TypeError('[vela] trusted identity roles must be an array');
    roles = Object.freeze(
      Array.from({ length: roleInput.length }, (_, index) =>
        component(readData(roleInput, String(index)), 'role'),
      ),
    );
  }
  const claimInput = readData(identity, 'claims');
  const claims = claimInput === undefined ? undefined : snapshotClaims(claimInput);
  identityByRequest.set(request, {
    identity: Object.freeze({
      principal: Object.freeze({ issuer, subject, principalType }),
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(roles === undefined ? {} : { roles }),
      ...(claims === undefined ? {} : { claims }),
    }),
  });
}

/** Clear before every authentication attempt, logout, or anonymous/public route. */
export function clearTrustedRequestIdentity(request: Request): void {
  identityByRequest.delete(request);
}

/** Expired identities disappear for every consumer, including throttling. */
export function getTrustedRequestIdentity(request: Request): TrustedRequestIdentity | undefined {
  return authenticationState(request)?.identity;
}

function authenticationState(request: Request): AuthenticationState | undefined {
  const state = identityByRequest.get(request);
  if (state?.identity.expiresAtMs !== undefined && state.identity.expiresAtMs <= Date.now()) {
    identityByRequest.delete(request);
    return undefined;
  }
  return state;
}

/**
 * The request's trusted identity, read through `REQUEST_CONTEXT`:
 * `context.get(TRUSTED_REQUEST_IDENTITY)`. It is a view of
 * `getTrustedRequestIdentity(request)`; `set()` throws, so publication stays
 * with `setTrustedRequestIdentity` after verification.
 */
export const TRUSTED_REQUEST_IDENTITY =
  /* @__PURE__ */ new RequestContextKey<TrustedRequestIdentity>('vela.trusted-request-identity', {
    derive: (context) => getTrustedRequestIdentity(context.request),
  });

/**
 * Publish a tenant only after server-side admission, without reauthenticating.
 * The exact expected snapshot must still be current and unexpired. An already
 * bound tenant cannot change. Principal, roles, claims and expiry are preserved.
 * Provider payload survives; ordinary set/clear still invalidates it.
 */
export function setTrustedRequestTenant(
  request: Request,
  expectedIdentity: TrustedRequestIdentity,
  tenantId: string,
): TrustedRequestIdentity {
  const state = authenticationState(request);
  if (!state || state.identity !== expectedIdentity) {
    throw new TypeError('[vela] tenant admission requires the current live identity');
  }
  const tenant = component(tenantId, 'tenantId');
  if (state.identity.tenantId !== undefined && state.identity.tenantId !== tenant) {
    throw new TypeError('[vela] tenant admission cannot replace a bound tenant');
  }
  if (state.identity.tenantId === tenant) return state.identity;
  state.identity = Object.freeze({ ...state.identity, tenantId: tenant });
  return state.identity;
}

/** Provider-owned payload, available only during its live authentication. */
export interface TrustedRequestIdentityStore<T> {
  get(request: Request): T | undefined;
  /** Requires a verified identity already published on this request. */
  set(request: Request, value: T): void;
}

/**
 * Creates an independent attachment store. Payload is never authority and does
 * not survive clear, expiry, or identity replacement (even equal principals).
 * The authentication record is private to core; stores cannot revive it.
 */
export function createTrustedRequestIdentityStore<T>(): TrustedRequestIdentityStore<T> {
  const values = new WeakMap<AuthenticationState, T>();
  return Object.freeze({
    get(request: Request): T | undefined {
      const state = authenticationState(request);
      return state ? values.get(state) : undefined;
    },
    set(request: Request, value: T): void {
      const state = authenticationState(request);
      if (!state) throw new TypeError('[vela] identity payload requires a live identity');
      values.set(state, value);
    },
  });
}
