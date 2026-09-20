/**
 * `@velajs/studio/timetravel` — the portable time-travel tier: the
 * `TIME_TRAVEL_PORT` token, the NDJSON snapshot store seam, the
 * {@link SnapshotTimeTravelAdapter}, the optional CDC {@link ChangeSource} seam,
 * and the opt-in {@link StudioTimeTravelModule}. The `timeTravel.*` ops
 * themselves ship on the core `@velajs/studio` entry (stable wire surface).
 *
 * Crud-free by design (the optional-peer discipline): the audit-backed
 * `AuditStoreChangeSource` that maps `@velajs/crud`'s audit log to this seam
 * lives in the `@velajs/studio/crud` subpath, never here.
 */
export const STUDIO_TIMETRAVEL_MODULE_ID = 'studio.timetravel';

export { TIME_TRAVEL_PORT } from './port.token';

export { SNAPSHOT_STORE, InMemorySnapshotStore } from './snapshot-store.port';
export type { SnapshotStore } from './snapshot-store.port';

export { CHANGE_SOURCE } from './change-source.port';
export type { ChangeSource } from './change-source.port';

export { schemaHashForColumns, combinedSchemaHash } from './schema-hash';

export { NoopLiveInvalidator, ContainerLiveInvalidator } from './live-invalidation';
export type { LiveInvalidatorPort } from './live-invalidation';

export { SnapshotTimeTravelAdapter } from './snapshot.adapter';
export type { SnapshotAdapterDeps } from './snapshot.adapter';

export { StudioTimeTravelOps } from './timetravel.ops';

export { StudioTimeTravelModule, STUDIO_TIMETRAVEL_MODULE_OPTIONS } from './timetravel.module';
export type { StudioTimeTravelModuleOptions } from './timetravel.module';
