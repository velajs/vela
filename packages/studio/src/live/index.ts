import { Inject, Injectable, defineProvider } from '@velajs/vela';
import { Container, readEnv, type EnvFactory } from '@velajs/vela/module-kit';
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
   * The scope this admin inspects, or a function that builds it from the
   * application's `ENV` (a Durable Object room's `inspectLive()` RPC). There is
   * no implicit global room discovery; without a source the panel stays off.
   */
  source?: StudioLiveSource | EnvFactory<StudioLiveSource>;
}

/**
 * The live and presence panel: authenticated polling over an app-owned
 * inspection source, lighting the `live` and `presence` features:
 * `StudioModule.forRoot({ plugins: [livePanel({ source: (env) => ... })] })`.
 */
export function livePanel(options: LivePanelOptions = {}): StudioPlugin {
  const { source } = options;
  return defineStudioPlugin({
    name: 'live',
    providers: [
      defineProvider(STUDIO_LIVE_SOURCE, {
        inject: [Container],
        useFactory: (container: Container) =>
          typeof source === 'function' ? source(readEnv(container)) : source,
      }),
      StudioLiveOps,
    ],
  });
}
