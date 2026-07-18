import { defineModule, stableHash } from '../index';
import { InMemoryCursorLog } from './live.cursor';
import { LiveEngine } from './live.engine';
import { LiveInvalidation, localLive, perAppLiveDriver } from './live.invalidation';
import { LIVE_CURSOR_LOG, LIVE_DRIVER, LIVE_MODULE_OPTIONS } from './live.tokens';
import type { LiveDriver, LiveModuleOptions } from './live.types';
import { PresenceResolver, PresenceService } from './presence';

const liveReferenceIds = new WeakMap<object, number>();
let nextLiveReferenceId = 1;

function liveReferenceId(value: unknown): string {
  if (value === undefined) return 'none';
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const reference = value as object;
    let id = liveReferenceIds.get(reference);
    if (id === undefined) {
      id = nextLiveReferenceId++;
      liveReferenceIds.set(reference, id);
    }
    return `object:${id}`;
  }
  return `${typeof value}:${String(value)}`;
}

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
 * App code declares `@LiveResolver` classes with `@LiveQuery(name, { tags })`
 * methods; clients subscribe over the `$live` reserved WebSocket event; writes
 * invalidate tags via `LiveInvalidation` (the `@velajs/crud` bridge does it
 * automatically per table). See `LIVE.md` for the wire protocol, delivery
 * guarantees, and the resume story.
 *
 * Deliberately EAGER (like WebSocketModule): the engine self-drives — it
 * claims the `$live` event at bootstrap and receives invalidations from
 * writes that never touch a live token — so the lazy-module contract
 * ("nothing self-drives") rules laziness out.
 */
const { ConfigurableModuleClass } = defineModule<LiveModuleOptions>({
  name: 'Live',
  optionsToken: LIVE_MODULE_OPTIONS,
  key: (options) =>
    stableHash({
      driverKind: options?.driver?.kind ?? 'local',
      driver: liveReferenceId(options?.driver),
      log: liveReferenceId(options?.log),
      identity: liveReferenceId(options?.identity),
      authorizeDelivery: liveReferenceId(options?.authorizeDelivery),
      maxSubscriptionsPerSocket: options?.maxSubscriptionsPerSocket ?? 100,
      maxRefreshFanout: options?.maxRefreshFanout ?? 10_000,
      maxTags: options?.maxTags ?? 100,
      presence: options?.presence === false ? false : { ttlMs: options?.presence?.ttlMs ?? 30_000 },
    }),
  setup: ({ OPTIONS, options }) => ({
    providers: [
      {
        provide: LIVE_CURSOR_LOG,
        useFactory: (o: LiveModuleOptions) => o.log ?? new InMemoryCursorLog(),
        inject: [OPTIONS],
      },
      {
        provide: LIVE_DRIVER,
        // Wrapped per app: user-supplied drivers are shared config objects
        // (the same module bootstraps in the Worker AND in each Durable
        // Object), so per-app sink/mode state lives in the wrapper — see
        // perAppLiveDriver.
        useFactory: (o: LiveModuleOptions) => perAppLiveDriver(o.driver ?? localLive()),
        inject: [OPTIONS],
      },
      {
        provide: PresenceService,
        useFactory: (o: LiveModuleOptions) => {
          const presence = o.presence;
          if (presence === false) return new PresenceService(undefined, false);
          return new PresenceService(presence?.ttlMs, true);
        },
        inject: [OPTIONS],
      },
      {
        provide: LiveInvalidation,
        useFactory: (driver: LiveDriver) => new LiveInvalidation(driver),
        inject: [LIVE_DRIVER],
      },
      LiveEngine,
      // The built-in `$presence.roster` resolver. Skipping it is STRUCTURAL
      // (`presence: false` must be visible at forRoot/forRootAsync call time,
      // like queue's `queues`); a disabled-at-runtime service still no-ops.
      ...(options?.presence === false ? [] : [PresenceResolver]),
    ],
    exports: [LiveEngine, LiveInvalidation, LIVE_DRIVER, LIVE_CURSOR_LOG, PresenceService],
  }),
});

export class LiveModule extends ConfigurableModuleClass {}
