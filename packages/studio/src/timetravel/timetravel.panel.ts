/**
 * `timeTravelPanel()` — the opt-in binding for the PORTABLE time-travel tier.
 * It wires the {@link SnapshotTimeTravelAdapter} to `TIME_TRAVEL_PORT` given a
 * {@link SnapshotStore} (defaults to an in-memory store per application) and
 * the app's bound `STUDIO_MODEL_SOURCE`. Add it next to a model-source panel
 * such as `crudPanel()`:
 *
 *   StudioModule.forRoot({ token, plugins: [crudPanel(), timeTravelPanel()] })
 *
 * The `timeTravel.*` ops live on the core `StudioModule` (stable wire surface)
 * and report `TIMETRAVEL_UNAVAILABLE` until this panel binds the port. Pass a
 * `changeSource` to enable audit-backed CDC replay (`granularity: 'snapshot+cdc'`
 * — see `@velajs/studio/crud`'s `AuditStoreChangeSource`).
 */
import { defineProvider, type ModuleImport } from '@velajs/vela';
import { readEnv, type Container, type EnvFactory } from '@velajs/vela/module-kit';
import { STUDIO_APPLICATION_CONTAINER } from '../tokens';
import { ConfirmTokenSigner } from '../security/confirm-token';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import type { StudioModelSource } from '../data/model-source.port';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';
import { TIME_TRAVEL_PORT } from './port.token';
import { SNAPSHOT_STORE, InMemorySnapshotStore } from './snapshot-store.port';
import type { SnapshotStore } from './snapshot-store.port';
import type { ChangeSource } from './change-source.port';
import { ContainerLiveInvalidator } from './live-invalidation';
import { SnapshotTimeTravelAdapter } from './snapshot.adapter';

/** Options for {@link timeTravelPanel}. */
export interface TimeTravelPanelOptions {
  /** Modules exporting a model source bound outside Studio (a BYO source module). */
  imports?: readonly ModuleImport[];
  /**
   * Where snapshots persist, or a function that builds the store from the
   * application's `ENV`. Default: an in-memory store per application
   * (single-instance/dev).
   */
  store?: SnapshotStore | EnvFactory<SnapshotStore>;
  /** OPTIONAL audit-backed CDC seam; presence upgrades granularity to `snapshot+cdc`. */
  changeSource?: ChangeSource | EnvFactory<ChangeSource>;
  /** Rows pulled per page while streaming a snapshot. Default 500. */
  perPage?: number;
}

/**
 * Binds the {@link SnapshotTimeTravelAdapter} to `TIME_TRAVEL_PORT`. Requires a
 * bound `STUDIO_MODEL_SOURCE` (from `crudPanel()` or a BYO source panel).
 */
export function timeTravelPanel(options: TimeTravelPanelOptions = {}): StudioPlugin {
  const { imports, store, changeSource, perPage } = options;
  return defineStudioPlugin({
    name: 'time-travel',
    ...(imports === undefined ? {} : { imports }),
    providers: [
      defineProvider(SNAPSHOT_STORE, {
        useFactory: (container: Container) =>
          typeof store === 'function'
            ? store(readEnv(container))
            : (store ?? new InMemorySnapshotStore()),
        inject: [STUDIO_APPLICATION_CONTAINER],
      }),
      defineProvider(TIME_TRAVEL_PORT, {
        useFactory: (
          source: StudioModelSource,
          confirm: ConfirmTokenSigner,
          container: Container,
          snapshots: SnapshotStore,
        ) => {
          const changes =
            typeof changeSource === 'function' ? changeSource(readEnv(container)) : changeSource;
          return new SnapshotTimeTravelAdapter({
            store: snapshots,
            source,
            confirm,
            live: new ContainerLiveInvalidator(container),
            ...(changes !== undefined ? { changeSource: changes } : {}),
            ...(perPage !== undefined ? { perPage } : {}),
          });
        },
        inject: [
          STUDIO_MODEL_SOURCE,
          ConfirmTokenSigner,
          STUDIO_APPLICATION_CONTAINER,
          SNAPSHOT_STORE,
        ],
      }),
    ],
  });
}
