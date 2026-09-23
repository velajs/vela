import type { ExecutionContext } from '@velajs/vela';
import {
  clearTrustedRequestIdentity,
  createTrustedRequestIdentityStore,
  getTrustedContextRequest,
  setTrustedRequestIdentity,
} from '@velajs/vela/module-kit';
import type { SessionData } from './session-data';

// This map stores provider payload, never a second authentication authority.
// A clear, expiry, or identity replacement makes the payload unreachable.
const sessions = createTrustedRequestIdentityStore<SessionData>();

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
  sessions.set(request, data);
}

export function getAuthRequestState(context: ExecutionContext): SessionData | undefined {
  const request = getTrustedContextRequest(context);
  return request ? sessions.get(request) : undefined;
}
