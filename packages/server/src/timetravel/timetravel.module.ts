/**
 * `StudioTimeTravelModule` — the opt-in binding for the PORTABLE time-travel
 * tier. It wires the {@link SnapshotTimeTravelAdapter} to `TIME_TRAVEL_PORT`
 * given a {@link SnapshotStore} (defaults to the in-memory impl) and the app's
 * bound `STUDIO_MODEL_SOURCE`. Import it ALONGSIDE `StudioModule` (and a model-
 * source module such as `StudioCrudModule`) in apps that want time travel:
 *
 *   imports: [StudioModule.forRoot({ token }), StudioCrudModule.forRoot({}),
 *             StudioTimeTravelModule.forRoot({})]
 *
 * The `timeTravel.*` ops live on the core `StudioModule` (stable wire surface)
 * and report `TIMETRAVEL_UNAVAILABLE` until this module binds the port. Pass a
 * `changeSource` to enable audit-backed CDC replay (`granularity: 'snapshot+cdc'`
 * — see `@velajs/studio/crud`'s `AuditStoreChangeSource`).
 */
import { Container, defineModule } from '@velajs/vela';
import { ConfirmTokenSigner } from '../security/confirm-token';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import type { StudioModelSource } from '../data/model-source.port';
import { TIME_TRAVEL_PORT } from './port.token';
import { SNAPSHOT_STORE, InMemorySnapshotStore } from './snapshot-store.port';
import type { SnapshotStore } from './snapshot-store.port';
import type { ChangeSource } from './change-source.port';
import { ContainerLiveInvalidator } from './live-invalidation';
import { SnapshotTimeTravelAdapter } from './snapshot.adapter';

/** Options for {@link StudioTimeTravelModule}. */
export interface StudioTimeTravelModuleOptions {
  /** Where snapshots persist. Default: an in-memory store (single-instance/dev). */
  store?: SnapshotStore;
  /** OPTIONAL audit-backed CDC seam; presence upgrades granularity to `snapshot+cdc`. */
  changeSource?: ChangeSource;
  /** Rows pulled per page while streaming a snapshot. Default 500. */
  perPage?: number;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  defineModule<StudioTimeTravelModuleOptions>({
    name: 'StudioTimeTravel',
    setup: ({ OPTIONS }) => ({
      providers: [
        {
          provide: SNAPSHOT_STORE,
          useFactory: (options: StudioTimeTravelModuleOptions) =>
            options.store ?? new InMemorySnapshotStore(),
          inject: [OPTIONS],
        },
        {
          provide: TIME_TRAVEL_PORT,
          useFactory: (
            source: StudioModelSource,
            confirm: ConfirmTokenSigner,
            container: Container,
            store: SnapshotStore,
            options: StudioTimeTravelModuleOptions,
          ) =>
            new SnapshotTimeTravelAdapter({
              store,
              source,
              confirm,
              live: new ContainerLiveInvalidator(container),
              ...(options.changeSource !== undefined ? { changeSource: options.changeSource } : {}),
              ...(options.perPage !== undefined ? { perPage: options.perPage } : {}),
            }),
          inject: [STUDIO_MODEL_SOURCE, ConfirmTokenSigner, Container, SNAPSHOT_STORE, OPTIONS],
        },
      ],
      exports: [TIME_TRAVEL_PORT, SNAPSHOT_STORE],
    }),
  });

/**
 * Binds the {@link SnapshotTimeTravelAdapter} to `TIME_TRAVEL_PORT`. Requires a
 * bound `STUDIO_MODEL_SOURCE` (from `StudioCrudModule` or a BYO source module).
 */
export class StudioTimeTravelModule extends ConfigurableModuleClass {}
export { MODULE_OPTIONS_TOKEN as STUDIO_TIMETRAVEL_MODULE_OPTIONS };
