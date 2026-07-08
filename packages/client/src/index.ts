export { LiveClient } from './live-client';
export { RoomConnection } from './connection';
export { applyServerFrame } from './frame-reducer';
export type { FrameEffect } from './frame-reducer';
export {
  applyOptimisticLayer,
  dropConfirmedLayers,
  foldOptimistic,
} from './optimistic';
export type { CommitStamp, LayerHandle, OptimisticHost, OptimisticLayer } from './optimistic';
export {
  argsKeyOf,
  createSubscriptionState,
  refold,
  subscriptionKey,
} from './subscription';
export type { SubscriptionState } from './subscription';
export { VelaLiveError, getErrorCode, isVelaLiveError } from './errors';
export {
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_CAP_MS,
  nextReconnectDelay,
  resetReconnect,
} from './reconnect';
export { stableStringify } from './stable-key';
export type {
  ArgsOf,
  ConnectionStatus,
  HydrationEntry,
  LiveClientOptions,
  LiveContract,
  LiveStore,
  MutateOptions,
  OptimisticTarget,
  OutboxSink,
  ReadCacheAdapter,
  ReconnectOptions,
  ResultOf,
  SubscribeOptions,
  Unsubscribe,
  WebSocketFactory,
  WebSocketLike,
} from './types';

// The wire contract, re-exported for tooling/tests.
export {
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  LIVE_EVENT,
  LIVE_PROTOCOL,
  applyListDelta,
  encodeListDelta,
} from '@velajs/live-protocol';
export type { ClientLiveFrame, RowOp, ServerLiveFrame } from '@velajs/live-protocol';
