/**
 * `@velajs/client/offline` — the offline-write surface: the reference in-memory
 * {@link MutationStore}, the OCC snapshot-precondition helper, and the offline
 * option/record types. The queue engine itself ({@link MutationQueue}) and its
 * wiring live on `LiveClient` and are re-exported from the package root.
 */
export { createMemoryMutationStore } from './memory-store';
export { createSnapshotPrecondition } from './snapshot-precondition';
export type {
  MutationStore,
  MutationStoreScope,
  MutationSettledEvent,
  MutationVerdict,
  OfflineQueueOptions,
  PersistedMutation,
} from './types';
