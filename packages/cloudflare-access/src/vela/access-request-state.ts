import {
  getTrustedRequestIdentity,
  type ExecutionContext,
  type TrustedRequestIdentity,
} from '@velajs/vela';
import type { ResolvedIdentity } from '../types';

// Provider payload only. Authorization always reads the canonical core identity.
// Weak keys make this payload disappear after expiry, clearing, or replacement.
const payloads = new WeakMap<TrustedRequestIdentity, Readonly<ResolvedIdentity>>();

export function attachAccessPayload(request: Request, payload: ResolvedIdentity): void {
  const trusted = getTrustedRequestIdentity(request);
  if (trusted) payloads.set(trusted, Object.freeze(structuredClone(payload)));
}

export function getAccessRequestIdentity(
  context: ExecutionContext,
): Readonly<ResolvedIdentity> | undefined {
  if (context.getType() !== 'http') return undefined;
  const trusted = getTrustedRequestIdentity(context.getRequest());
  return trusted && payloads.get(trusted);
}
