import { Inject, Injectable, defineProvider } from '@velajs/vela';
import { Container, readEnv, type EnvFactory } from '@velajs/vela/module-kit';
import { LiveInspector } from '@velajs/vela/live';
import type { LiveSubscriptionRow, PresenceRoomRow } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';
import { STUDIO_LIVE_SOURCE } from './live.port';
import type { StudioLiveSource } from './live.port';

export { STUDIO_LIVE_SOURCE } from './live.port';
export type { StudioLiveSource } from './live.port';

@Injectable()
export class StudioLiveOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'live.subscriptions' })
  async subscriptions(_ctx: AdminOpContext): Promise<LiveSubscriptionRow[]> {
    return (await this.source().inspect()).subscriptions;
  }

  @AdminRpc({ op: 'presence.rooms' })
  async rooms(_ctx: AdminOpContext): Promise<PresenceRoomRow[]> {
    return (await this.source().inspect()).rooms;
  }

  private source(): StudioLiveSource {
    const source = this.container.has(STUDIO_LIVE_SOURCE)
      ? this.container.resolve(STUDIO_LIVE_SOURCE)
      : undefined;
    if (!source)
      throw studioError('FEATURE_UNCONFIGURED', 'no live inspection source is configured');
    return source;
  }
}

export interface LivePanelOptions {
  /**
   * Rooms Studio inspects through `LiveModule`, read where their subscriptions
   * live: on Cloudflare each room's Durable Object, reached through the
   * gateway binding the live driver delivers to; elsewhere the application's
   * own engine. There is no global room list, so name each room.
   */
  rooms?: readonly string[];
  /**
   * A custom inspection source instead of `rooms`, or a function that builds
   * it from the application's `ENV`.
   */
  source?: StudioLiveSource | EnvFactory<StudioLiveSource>;
}

/** The inspection source `LiveModule` provides for the named rooms. */
function liveRoomsSource(container: Container, rooms: readonly string[]): StudioLiveSource {
  if (!container.has(LiveInspector)) {
    throw new Error(
      'livePanel({ rooms }) reads rooms through LiveModule: import LiveModule.forRoot() ' +
        'from @velajs/vela/live.',
    );
  }
  const named = [...rooms];
  return {
    async inspect() {
      const snapshot = await container.resolve(LiveInspector).inspect(named);
      return {
        subscriptions: snapshot.subscriptions.map(({ id, room, tags, connectedAt, clientId }) => ({
          id,
          room,
          tags,
          connectedAt,
          clientId,
        })),
        rooms: snapshot.rooms,
      };
    },
  };
}

/**
 * The live and presence panel: authenticated polling of live subscriptions
 * and presence rooms, lighting the `live` and `presence` features. It reads
 * the rooms named in `rooms` through `LiveModule`, or a custom `source`;
 * without either the features stay off:
 * `StudioModule.forRoot({ plugins: [livePanel({ rooms: ['default'] })] })`.
 */
export function livePanel(options: LivePanelOptions = {}): StudioPlugin {
  const { rooms, source } = options;
  if (rooms !== undefined && source !== undefined) {
    throw new TypeError('livePanel takes either rooms or source, not both.');
  }
  return defineStudioPlugin({
    name: 'live',
    providers: [
      defineProvider(STUDIO_LIVE_SOURCE, {
        inject: [Container],
        useFactory: (container: Container) => {
          if (rooms !== undefined) return liveRoomsSource(container, rooms);
          return typeof source === 'function' ? source(readEnv(container)) : source;
        },
      }),
      StudioLiveOps,
    ],
  });
}
