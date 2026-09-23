// The internal-dispatch seam (`ctx.run`): re-enter the app through a
// per-invocation SIGNED route. Consumed by QueueModule / ScheduleModule /
// (future) WorkflowModule handlers so they can call back into the app without a
// shared bearer token.

export { InternalDispatcher } from './internal-dispatcher';
export { SignedInvocationGuard, SignedInvocation } from './signed-invocation.guard';
export { MemoryNonceStore, NONCE_STORE } from './nonce-store';
export { INVOCATION_HEADER, INVOCATION_SIGNING_SECRET, INVOCATION_TRANSPORT } from './tokens';
export type {
  InvocationTransport,
  InvocationTarget,
  InvocationRouteTarget,
  InvocationPathTarget,
  RunInit,
  NonceStore,
} from './types';
