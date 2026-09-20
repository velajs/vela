import {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  type ExecutionContext,
  type TrustedRequestIdentity,
} from '@velajs/vela';
import type { SessionData } from './session-data';

// This map stores provider payload, never a second authentication authority.
// A clear, expiry, or identity replacement makes the payload unreachable.
const sessions = new WeakMap<TrustedRequestIdentity, SessionData>();

export function beginAuthRequest(context: ExecutionContext): void {
  clearTrustedRequestIdentity(context.getRequest());
}

export function authenticateRequest(
  context: ExecutionContext,
  data: SessionData,
  issuer: string,
): void {
  const request = context.getRequest();
  setTrustedRequestIdentity(request, {
    principal: { issuer, subject: data.user.id, principalType: 'user' },
    expiresAtMs: data.session.expiresAt.getTime(),
    roles: data.roles,
    ...(data.tenantId === undefined ? {} : { tenantId: data.tenantId }),
  });
  const identity = getTrustedRequestIdentity(request);
  if (identity) sessions.set(identity, data);
}

export function getAuthRequestState(context: ExecutionContext): SessionData | undefined {
  if (context.getType() !== 'http') return undefined;
  const identity = getTrustedRequestIdentity(context.getRequest());
  return identity && sessions.get(identity);
}
