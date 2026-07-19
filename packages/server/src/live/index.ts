/**
 * `@velajs/studio/live` — the OPTIONAL `@velajs/vela/live` binding for the live
 * + presence panels.
 *
 * This subpath is the ONLY module in the package that imports `@velajs/vela/live`:
 * the core `.` entry never does. An app imports `StudioLiveModule` ALONGSIDE
 * `StudioModule` (and `LiveModule`/`WebSocketModule`); registration lights the
 * `live` AND `presence` features by op-namespace (in UNION with the pre-existing
 * `websocket` entrypoint-kind / `WS_SERVER` probe the M4 features service reads).
 *
 * HONEST DEGRADATION (the crux of this namespace): these are the "polling in v1"
 * ops — they read CURRENT state, not a `@LiveResolver`. In vela 1.20 the PUBLIC
 * surface exposes NO enumeration: `LiveEngine` keeps its subscription registry
 * private, `WsServer` offers no connected-client listing, and `PresenceService`
 * exposes `roster(room)` but no room enumeration. So `live.subscriptions` and
 * `presence.rooms` report `FEATURE_UNCONFIGURED` — the engine/presence service is
 * DETECTED (so the message distinguishes "not wired" from "wired but not
 * introspectable"), but the current state is not readable through a public seam.
 * A platform live driver / presence store that exposes enumeration is the upgrade
 * path; the ops' wire shape is frozen and ready for it.
 */
import { Container, Inject, Injectable, defineModule } from '@velajs/vela';
import { LIVE_DRIVER, PresenceService } from '@velajs/vela/live';
import type { LiveSubscriptionRow, PresenceRoomRow } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';

export const STUDIO_LIVE_MODULE_ID = 'studio.live';

@Injectable()
export class StudioLiveOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'live.subscriptions' })
  subscriptions(_ctx: AdminOpContext): LiveSubscriptionRow[] {
    // `LiveEngine`'s subscription registry is private and `WsServer` exposes no
    // connected-client listing — no public seam enumerates active subscriptions.
    throw studioError(
      'FEATURE_UNCONFIGURED',
      this.container.has(LIVE_DRIVER)
        ? 'the bound live engine does not expose active-subscription enumeration through the public API'
        : 'no LiveModule is wired',
    );
  }

  @AdminRpc({ op: 'presence.rooms' })
  rooms(_ctx: AdminOpContext): PresenceRoomRow[] {
    // `PresenceService.roster(room)` is per-room; there is no public room
    // enumeration to iterate, so the current roster set is not readable.
    throw studioError(
      'FEATURE_UNCONFIGURED',
      this.container.has(PresenceService)
        ? 'the presence service exposes roster(room) but no public room enumeration'
        : 'presence is not enabled on the wired LiveModule',
    );
  }
}

/** Options for {@link StudioLiveModule}. Reserved for future live-panel wiring. */
export type StudioLiveModuleOptions = Record<string, never>;

const { ConfigurableModuleClass } = defineModule<StudioLiveModuleOptions>({
  name: 'StudioLive',
  setup: () => ({ providers: [StudioLiveOps] }),
});

/**
 * Registers {@link StudioLiveOps}. Import it with `StudioLiveModule.forRoot({})`
 * ALONGSIDE `StudioModule` (and `LiveModule`) in apps that use live queries /
 * presence.
 */
export class StudioLiveModule extends ConfigurableModuleClass {}
