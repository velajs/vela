// @velajs/vela/dispatch — the internal-dispatch seam (`ctx.run`): re-enter the
// app through a per-invocation SIGNED route (scoped claim, short expiry,
// single-use nonce — no shared bearer). Consumed by QueueModule / ScheduleModule
// / (future) WorkflowModule handlers so they can call back into the app.
import '../metadata';

export { InternalDispatcher } from './internal-dispatcher';
export { SignedInvocationGuard, SignedInvocation } from './signed-invocation.guard';
export { INVOCATION_SIGNING_SECRET } from './tokens';
export type {
  InvocationTransport,
  InvocationTarget,
  InvocationRouteTarget,
  InvocationPathTarget,
  RunInit,
} from './types';
export {
  signInvocation,
  verifyInvocation,
  INVOCATION_AUDIENCE,
  INVOCATION_DEFAULT_TTL_SECONDS,
} from '../crypto/invocation';
export type { InvocationClaim, VerifyInvocationOptions } from '../crypto/invocation';
