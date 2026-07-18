import type { ExecutionContext } from '@velajs/vela';
import type { Session, User } from './better-auth.types';

export interface AuthenticatedRequestState {
  readonly authenticated: true;
  readonly user: User;
  readonly session: Session;
  readonly issuer: string;
  readonly principalType: 'user';
}

interface AnonymousRequestState {
  readonly authenticated: false;
}

export type AuthRequestState = AuthenticatedRequestState | AnonymousRequestState;

const ANONYMOUS: AnonymousRequestState = Object.freeze({ authenticated: false });

// Canonical authentication state is request-local and unforgeable by upstream
// Hono middleware. It deliberately does not depend on resolving a DI token:
// guards execute before parameter extraction and test harnesses may load Vela's
// public/internal entry points as separate module instances. Both execution
// contexts still expose the same raw Request object.
const stateByRequest = new WeakMap<Request, AuthRequestState>();

/** Clear any state before a guard evaluates a request. */
export const beginAuthRequest = (context: ExecutionContext): void => {
  stateByRequest.set(context.getRequest(), ANONYMOUS);
};

/** Publish a fully verified session for downstream guards and parameters. */
export const authenticateRequest = (
  context: ExecutionContext,
  state: Omit<AuthenticatedRequestState, 'authenticated'>,
): AuthenticatedRequestState => {
  const authenticated: AuthenticatedRequestState = Object.freeze({
    authenticated: true,
    ...state,
  });
  stateByRequest.set(context.getRequest(), authenticated);
  return authenticated;
};

/** Missing state is anonymous: no guard means no ambient identity. */
export const getAuthRequestState = (context: ExecutionContext): AuthRequestState =>
  context.getType() === 'http'
    ? (stateByRequest.get(context.getRequest()) ?? ANONYMOUS)
    : ANONYMOUS;
