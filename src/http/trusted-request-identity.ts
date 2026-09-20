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
const identityByRequest = new WeakMap<Request, TrustedRequestIdentity>();
const identityEncoder = new TextEncoder();

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
  identityByRequest.set(
    request,
    Object.freeze({
      principal: Object.freeze({ issuer, subject, principalType }),
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(roles === undefined ? {} : { roles }),
      ...(claims === undefined ? {} : { claims }),
    }),
  );
}

/** Clear before every authentication attempt, logout, or anonymous/public route. */
export function clearTrustedRequestIdentity(request: Request): void {
  identityByRequest.delete(request);
}

/** Expired identities disappear for every consumer, including throttling. */
export function getTrustedRequestIdentity(request: Request): TrustedRequestIdentity | undefined {
  const identity = identityByRequest.get(request);
  if (identity?.expiresAtMs !== undefined && identity.expiresAtMs <= Date.now()) {
    identityByRequest.delete(request);
    return undefined;
  }
  return identity;
}
