import { Inject, Injectable, defineModule, defineProvider } from '@velajs/vela';
import { Container } from '@velajs/vela/module-kit';
import type { LiveSubscriptionRow, PresenceRoomRow } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';
import { STUDIO_LIVE_SOURCE } from './live.port';
import type { StudioLiveSource } from './live.port';

export { STUDIO_LIVE_SOURCE } from './live.port';
export type { StudioLiveSource } from './live.port';
export const STUDIO_LIVE_MODULE_ID = 'studio.live';

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

export interface StudioLiveModuleOptions {
  /** No implicit global room discovery. Supply the scope this admin should inspect. */
  source?: StudioLiveSource;
}

const { ConfigurableModuleClass } = defineModule<StudioLiveModuleOptions>({
  name: 'StudioLive',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(STUDIO_LIVE_SOURCE, {
        inject: [OPTIONS],
        useFactory: (options) => options.source,
      }),
      StudioLiveOps,
    ],
    exports: [STUDIO_LIVE_SOURCE],
  }),
});

/** Authenticated polling over an app-owned inspection source; absent sources stay disabled. */
export class StudioLiveModule extends ConfigurableModuleClass {}
