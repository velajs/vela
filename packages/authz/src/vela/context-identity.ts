import type { ExecutionContext } from '@velajs/vela';
import {
  getTrustedRequestIdentity,
  getTrustedContextRequest,
  type TrustedRequestIdentity,
} from '@velajs/vela/module-kit';
import type { Identity } from '../identity';

/** Read an own data property without executing an untrusted getter. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * HTTP uses only core's verified request identity. WebSocket frames use only
 * the server's normalized connection attachment, never HTTP headers or frame
 * payloads. Roles/claims in arbitrary socket data are not trusted authority;
 * a resolver can look up grants using the verified principal and tenant.
 */
export function getContextIdentity(context: ExecutionContext): TrustedRequestIdentity | undefined {
  const request = getTrustedContextRequest(context);
  if (request) return getTrustedRequestIdentity(request);
  if (context.getType() !== 'ws') return undefined;
  try {
    // WsClient is framework-owned and may implement data as a class getter.
    const data: unknown = context.switchToWs().getClient().data;
    const principal = own(data, 'principal');
    const issuer = own(principal, 'issuer');
    const subject = own(principal, 'subject');
    const principalType = own(principal, 'principalType');
    const tenantId = own(data, 'tenantId');
    const expiresAtMs = own(data, 'expiresAtMs');
    if (
      !nonEmptyString(issuer) ||
      !nonEmptyString(subject) ||
      (principalType !== 'user' && principalType !== 'service') ||
      !nonEmptyString(tenantId) ||
      typeof expiresAtMs !== 'number' ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= Date.now()
    )
      return undefined;
    return { principal: { issuer, subject, principalType }, tenantId, expiresAtMs };
  } catch {
    return undefined;
  }
}

/** Project the one verified identity into the framework-independent engine. */
export function identityFromTrusted(identity: TrustedRequestIdentity): Identity {
  return {
    ...identity.principal,
    userId: identity.principal.subject,
    roles: identity.roles ?? [],
    ...(identity.tenantId === undefined ? {} : { tenantId: identity.tenantId }),
    ...(identity.expiresAtMs === undefined ? {} : { expiresAtMs: identity.expiresAtMs }),
    ...(identity.claims === undefined ? {} : { claims: identity.claims }),
  };
}
