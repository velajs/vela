import { defineModule } from '../module/define-module';
import { Inject, Injectable, Optional } from '../container/decorators';
import { defineProvider } from '../container/types';
import type { DynamicModule } from '../registry/types';
import { InMemoryCursorLog } from './live.cursor';
import { LiveEngine } from './live.engine';
import { LiveInvalidation, localLive } from './live.invalidation';
import { LIVE_CURSOR_LOG, LIVE_DRIVER, LIVE_MODULE_OPTIONS, LIVE_PLATFORM } from './live.tokens';
import type { CursorLog, LiveDriver, LiveModuleOptions, LivePlatform } from './live.types';
import { PresenceResolver, PresenceService } from './presence';

/** The platform wiring a runtime adapter registered, when there is one. */
@Injectable()
class LivePlatformRef {
  constructor(@Optional() @Inject(LIVE_PLATFORM) readonly platform?: LivePlatform) {}

  cursorLog(options: LiveModuleOptions): CursorLog | Promise<CursorLog> {
    return options.log?.() ?? this.platform?.cursorLog?.() ?? new InMemoryCursorLog();
  }

  driver(options: LiveModuleOptions): LiveDriver | Promise<LiveDriver> {
    const bind = (driver: LiveDriver): LiveDriver => {
      this.platform?.bindDriver?.(driver);
      return driver;
    };
    const configured = options.driver?.();
    if (configured instanceof Promise) return configured.then(bind);
    return bind(configured ?? this.platform?.liveDriver() ?? localLive());
  }
}

/**
 * First-party live-query module (tag-based realtime reactivity) — authored,
 * like the queue module, entirely on vela's public API (`live-openness.test.ts`
 * machine-verifies it; the only extra dependency is the shared wire package
 * `@velajs/live-protocol`).
 *
 * ```ts
 * imports: [WebSocketModule.forRoot(), LiveModule.forRoot()]
 * ```
 *
 * A runtime adapter's `LIVE_PLATFORM` supplies the driver and cursor log the
 * options leave open (`@velajs/cloudflare` routes Worker invalidations to the
 * gateway's room Durable Object and keeps a SQLite log inside it).
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
  // Presence is on unless disabled: `{}` and an absent `presence` are one engine.
  defaults: { presence: {} },
  setup: ({ OPTIONS, options }) => ({
    providers: [
      LivePlatformRef,
      defineProvider(LIVE_CURSOR_LOG, {
        useFactory: (resolved, platform: LivePlatformRef) => platform.cursorLog(resolved),
        inject: [OPTIONS, LivePlatformRef],
      }),
      defineProvider(LIVE_DRIVER, {
        // Configuration can be reused by many applications. Each application
        // owns its driver, including its sink and any platform binding state.
        useFactory: (resolved, platform: LivePlatformRef) => platform.driver(resolved),
        inject: [OPTIONS, LivePlatformRef],
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

type LiveModuleRegistration = Parameters<(typeof ConfigurableModuleClass)['forRoot']>[0];

export class LiveModule extends ConfigurableModuleClass {
  /** Register the live-query engine; every option is optional. */
  static override forRoot(options: LiveModuleRegistration = {}): DynamicModule {
    return super.forRoot(options);
  }
}
