import {
  getTrustedRequestIdentity,
  createTrustedRequestIdentityStore,
  getTrustedContextRequest,
  type ExecutionContext,
} from '@velajs/vela';
import type { ResolvedIdentity } from '../types';

// Provider payload only. Authorization always reads the canonical core identity.
// Weak keys make this payload disappear after expiry, clearing, or replacement.
const payloads = createTrustedRequestIdentityStore<Readonly<ResolvedIdentity>>();

export function attachAccessPayload(request: Request, payload: ResolvedIdentity): void {
  const trusted = getTrustedRequestIdentity(request);
  if (trusted) payloads.set(request, Object.freeze(structuredClone(payload)));
}

export function getAccessRequestIdentity(
  context: ExecutionContext,
): Readonly<ResolvedIdentity> | undefined {
  const request = getTrustedContextRequest(context);
  return request ? payloads.get(request) : undefined;
}
