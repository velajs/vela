export { LiveClient, createLiveClient } from './live-client';
export { RoomConnection } from './connection';
export type { ConnectionDeps } from './connection';
export { applyServerFrame, applySnapshotFrame, isCursorEpochPair } from './frame-reducer';
export type { FrameEffect } from './frame-reducer';
export { applyOptimisticLayer, dropConfirmedLayers, foldOptimistic } from './optimistic';
export type { CommitStamp, LayerHandle, OptimisticHost, OptimisticLayer } from './optimistic';
export { argsKeyOf, createSubscriptionState, refold, subscriptionKey } from './subscription';
export type { SubscriptionState } from './subscription';
export { MutationQueue, isStaleVersion } from './mutation-queue';
export type { EnqueueInput, MutationQueueDeps, QueuedMutation } from './mutation-queue';
export { createMemoryMutationStore } from './memory-store';
export { createSnapshotPrecondition } from './snapshot-precondition';
export { CrossTabCoordinator } from './cross-tab';
export type { CrossTabCallbacks, WantSpec } from './cross-tab';
export { ClientQueryStore, createClientQuery } from './client-query';
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
  BroadcastChannelFactory,
  BroadcastChannelLike,
  ClientQueryRef,
  ConnectionStatus,
  CrossTabOptions,
  HydrationEntry,
  LiveClientOptions,
  LiveContract,
  LiveContractShape,
  LiveQueryParsers,
  LiveQuerySchemas,
  InferLiveContract,
  LiveStore,
  MutateOptions,
  MutationResultOptions,
  MutationSettledEvent,
  MutationStore,
  MutationStoreScope,
  MutationVerdict,
  OfflineQueueOptions,
  OptimisticTarget,
  PersistedMutation,
  ReconnectOptions,
  ResultOf,
  SubscribeOptions,
  Unsubscribe,
  WebSocketFactory,
  WebSocketLike,
} from './types';

// The wire contract, re-exported for tooling/tests.
export {
  defineLiveQuery,
  COMMIT_CURSOR_HEADER,
  COMMIT_EPOCH_HEADER,
  LIVE_EVENT,
  LIVE_PROTOCOL,
  applyListDelta,
  encodeListDelta,
} from '@velajs/live-protocol';
export type {
  ClientLiveFrame,
  RowOp,
  ServerLiveFrame,
  LiveQueryDefinition,
} from '@velajs/live-protocol';
