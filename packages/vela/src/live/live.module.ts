import { defineModule } from '../module/define-module';
import { defineProvider } from '../container/types';
import { InMemoryCursorLog } from './live.cursor';
import { LiveEngine } from './live.engine';
import { LiveInvalidation, localLive } from './live.invalidation';
import { LIVE_CURSOR_LOG, LIVE_DRIVER, LIVE_MODULE_OPTIONS } from './live.tokens';
import type { LiveModuleOptions } from './live.types';
import { PresenceResolver, PresenceService } from './presence';

/**
 * First-party live-query module (tag-based realtime reactivity) — authored,
 * like the queue module, entirely on vela's public API (`live-openness.test.ts`
 * machine-verifies it; the only extra dependency is the shared wire package
 * `@velajs/live-protocol`).
 *
 * ```ts
 * imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})]
 * ```
 *
 * App code declares `@LiveResolver` classes with `@LiveQuery(name, definition, { tags })`
 * methods; clients subscribe over the `$live` reserved WebSocket event; writes
 * invalidate tags via `LiveInvalidation` (the `@velajs/crud` bridge does it
 * automatically per table). See `docs/live-queries.md` for the wire protocol, delivery
 * guarantees, and the resume story.
 *
 * Deliberately EAGER (like WebSocketModule): the engine self-drives — it
 * claims the `$live` event at bootstrap and receives invalidations from
 * writes that never touch a live token — so the lazy-module contract
 * ("nothing self-drives") rules laziness out.
 */
const { ConfigurableModuleClass } = defineModule<LiveModuleOptions, 'presence'>({
  name: 'Live',
  optionsToken: LIVE_MODULE_OPTIONS,
  // One engine per application: a second configuration fails bootstrap, not merged.
  structural: ['presence'],
  setup: ({ OPTIONS, options }) => ({
    providers: [
      defineProvider(LIVE_CURSOR_LOG, {
        useFactory: (options) => options.log?.() ?? new InMemoryCursorLog(),
        inject: [OPTIONS],
      }),
      defineProvider(LIVE_DRIVER, {
        // Configuration can be reused by many applications. Each application
        // owns its driver, including its sink and any platform binding state.
        useFactory: (options) => options.driver?.() ?? localLive(),
        inject: [OPTIONS],
      }),
      defineProvider(PresenceService, {
        useFactory: (options) => {
          const presence = options.presence;
          if (presence === false) return new PresenceService(undefined, false);
          return new PresenceService(presence?.ttlMs, true);
        },
        inject: [OPTIONS],
      }),
      defineProvider(LiveInvalidation, {
        useFactory: (driver) => new LiveInvalidation(driver),
        inject: [LIVE_DRIVER],
      }),
      LiveEngine,
      // The built-in `$presence.roster` resolver. Skipping it is structural:
      // `presence: false` is visible at the forRoot/forRootAsync call site.
      ...(options.presence === false ? [] : [PresenceResolver]),
    ],
    exports: [LiveEngine, LiveInvalidation, LIVE_DRIVER, LIVE_CURSOR_LOG, PresenceService],
  }),
});

export class LiveModule extends ConfigurableModuleClass {}
