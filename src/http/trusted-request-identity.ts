/**
 * Canonical principal shape published by a trusted authentication component.
 * This state is never inferred from request headers, cookies, or Hono variables.
 */
export interface TrustedRequestPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly principalType: 'user' | 'service';
}

/**
 * Authenticated identity available to framework security components.
 * `tenantId` is optional for single-tenant applications and pre-tenant routes.
 */
export interface TrustedRequestIdentity {
  readonly principal: TrustedRequestPrincipal;
  readonly tenantId?: string;
}

const MAX_IDENTITY_COMPONENT_LENGTH = 256;
const identityByRequest = new WeakMap<Request, TrustedRequestIdentity>();
const identityEncoder = new TextEncoder();

function readOwnString(
  value: object,
  key: string,
  options: { optional?: boolean } = {},
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined && options.optional) return undefined;
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`[vela] trusted request identity ${key} must be an own data property`);
  }
  const field: unknown = descriptor.value;
  if (
    typeof field !== 'string' ||
    field.length === 0 ||
    identityEncoder.encode(field).byteLength > MAX_IDENTITY_COMPONENT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(field)
  ) {
    throw new TypeError(`[vela] trusted request identity ${key} is invalid`);
  }
  return field;
}

/**
 * Publish verified identity state for this request.
 *
 * Call this only from trusted server-side authentication middleware or guards,
 * after credentials and tenant membership have been verified. The framework
 * deliberately provides no header-based adapter for this capability.
 */
export function setTrustedRequestIdentity(
  request: Request,
  identity: TrustedRequestIdentity,
): void {
  if (identity === null || typeof identity !== 'object') {
    throw new TypeError('[vela] trusted request identity must be an object');
  }
  const principalDescriptor = Object.getOwnPropertyDescriptor(identity, 'principal');
  if (
    principalDescriptor === undefined ||
    !('value' in principalDescriptor) ||
    principalDescriptor.value === null ||
    typeof principalDescriptor.value !== 'object'
  ) {
    throw new TypeError('[vela] trusted request identity principal must be an own data property');
  }

  const principal = principalDescriptor.value as object;
  const issuer = readOwnString(principal, 'issuer')!;
  const subject = readOwnString(principal, 'subject')!;
  const principalType = readOwnString(principal, 'principalType');
  if (principalType !== 'user' && principalType !== 'service') {
    throw new TypeError('[vela] trusted request identity principalType is invalid');
  }
  const tenantId = readOwnString(identity, 'tenantId', { optional: true });

  const canonicalPrincipal: TrustedRequestPrincipal = Object.freeze({
    issuer,
    subject,
    principalType,
  });
  identityByRequest.set(
    request,
    Object.freeze({
      principal: canonicalPrincipal,
      ...(tenantId === undefined ? {} : { tenantId }),
    }),
  );
}

/** Clear trusted identity before an authentication attempt or on an anonymous route. */
export function clearTrustedRequestIdentity(request: Request): void {
  identityByRequest.delete(request);
}

/** Read only identity state explicitly published by a trusted server component. */
export function getTrustedRequestIdentity(request: Request): TrustedRequestIdentity | undefined {
  return identityByRequest.get(request);
}
