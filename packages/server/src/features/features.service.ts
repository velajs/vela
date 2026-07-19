/**
 * Real feature detection — the death of the M2 all-`false` stub. Each Studio
 * feature key lights up iff there is concrete, app-scoped evidence the app wired
 * it. Evidence is unioned from three sources, all reachable through the public
 * `@velajs/vela` barrel:
 *
 *   (a) registered op namespaces — any `@AdminRpc` op whose meta `feature`
 *       matches (i.e. Studio ships handlers for it: `app`/`logs`/`audit` today);
 *   (b) the per-app `EntrypointRegistry` kinds (`queue`, `websocket`);
 *   (c) `Container.has(...)` probes for optional public tokens (schedule, live).
 *
 * Several keys are handled OUT-OF-BAND, never on op registration, because their
 * ops ship on the core `.` entry (registered unconditionally, so registration is
 * not a signal): `openapi` is gated SOLELY on a configured `rootModule`; `data`
 * and `transfer` SOLELY on a bound `STUDIO_MODEL_SOURCE` with ≥1 managed model
 * (transfer rides the same source); `timeTravel` SOLELY on a bound
 * `TIME_TRAVEL_PORT`; `auth` / `authOrganizations` SOLELY on a bound
 * `STUDIO_AUTH_SOURCE` (the `@velajs/studio/auth` subpath) reporting the matching
 * capability (admin / organization plugin) — the two auth sub-features light
 * INDEPENDENTLY. Absent evidence ⇒ false.
 *
 * The remaining optional namespaces (`queue`, `schedule`, `flags`, `live`,
 * `presence`) ship their ops in the M9 subpath modules (`@velajs/studio/{queue,
 * schedule,flags,live}`), so op-registration (source (a)) IS the honest signal —
 * unioned with the pre-existing entrypoint-kind (b) / probe-token (c) evidence
 * for queue/schedule/live.
 */
import {
  Container,
  EntrypointRegistry,
  Inject,
  Injectable,
  ScheduleRegistry,
  SCHEDULE_DISPATCH,
  WsDispatcher,
  WS_SERVER,
} from '@velajs/vela';
import type { Token } from '@velajs/vela';
import { STUDIO_FEATURE_KEYS, STUDIO_OP_META } from '@velajs/studio-protocol';
import type { StudioCapabilities, StudioFeatureKey } from '@velajs/studio-protocol';
import type { TimeTravelCapabilities } from '@velajs/studio-protocol';
import { STUDIO_RESOLVED_CONFIG } from '../tokens';
import { deriveWriteGates } from '../studio.types';
import type { ResolvedStudioConfig } from '../studio.types';
import { StudioDispatchRegistry } from '../rpc/dispatch.registry';
import { STUDIO_MODEL_SOURCE } from '../data/model-source.port';
import { TIME_TRAVEL_PORT } from '../timetravel/port.token';
import { STUDIO_AUTH_SOURCE } from '../auth/auth.port';
import type { StudioAuthCapabilities } from '../auth/auth.port';

/**
 * Per-feature entrypoint-kind evidence (source (b)). A kind counts only when the
 * app's OWN registry holds entries of it — never the process-global kind store.
 */
const FEATURE_ENTRYPOINT_KINDS: Partial<Record<StudioFeatureKey, readonly string[]>> = {
  queue: ['queue'],
  live: ['websocket'],
};

/**
 * Per-feature container-probe evidence (source (c)) — one table, public barrel
 * tokens only. Presence of ANY listed token (registered, even lazily) is proof
 * the feature's module is wired.
 */
const FEATURE_PROBE_TOKENS: Partial<Record<StudioFeatureKey, readonly Token[]>> = {
  schedule: [ScheduleRegistry, SCHEDULE_DISPATCH],
  live: [WS_SERVER, WsDispatcher],
};

@Injectable()
export class StudioFeaturesService {
  constructor(
    @Inject(STUDIO_RESOLVED_CONFIG) private readonly config: ResolvedStudioConfig,
    @Inject(Container) private readonly container: Container,
    @Inject(StudioDispatchRegistry) private readonly registry: StudioDispatchRegistry,
  ) {}

  /** Which feature namespaces this app can actually serve. */
  features(): Record<StudioFeatureKey, boolean> {
    const registered = this.registeredFeatures();
    const entrypointKinds = this.entrypointKinds();
    const out = {} as Record<StudioFeatureKey, boolean>;
    for (const key of STUDIO_FEATURE_KEYS) {
      out[key] = this.detect(key, registered, entrypointKinds);
    }
    return out;
  }

  /** The full capability descriptor returned by `studio.capabilities`. */
  capabilities(): StudioCapabilities {
    return {
      features: this.features(),
      writes: deriveWriteGates(this.config.editable),
      timeTravel: this.timeTravelCapabilities(),
    };
  }

  /**
   * The bound {@link TimeTravelPort}'s capabilities, or `null` when unbound OR
   * misconfigured. A bound port whose factory or `capabilities()` throws (e.g.
   * `TIME_TRAVEL_PORT` bound without a `STUDIO_MODEL_SOURCE`) must degrade
   * `timeTravel` to `null` — exactly like an unbound port — rather than 500 the
   * whole `studio.capabilities` op and black out every UI panel. The resolve +
   * `capabilities()` call is therefore guarded, matching how `data` degrades to
   * `false` instead of throwing.
   */
  private timeTravelCapabilities(): TimeTravelCapabilities | null {
    if (!this.container.has(TIME_TRAVEL_PORT)) return null;
    try {
      return this.container.resolve(TIME_TRAVEL_PORT).capabilities();
    } catch {
      return null;
    }
  }

  private detect(
    key: StudioFeatureKey,
    registered: ReadonlySet<StudioFeatureKey>,
    entrypointKinds: ReadonlySet<string>,
  ): boolean {
    // `openapi` is a configuration capability, not an op-registration one: it
    // is serviceable only when a root module is configured (createOpenApiDocument
    // has nothing to scan otherwise), regardless of `app.openapi` being wired.
    if (key === 'openapi') return this.config.rootModule !== undefined;

    // `data` is likewise out-of-band: the data ops are registered
    // unconditionally, so the honest signal is a bound model source that
    // actually discovers at least one managed model.
    if (key === 'data') return this.dataBound();

    // `timeTravel` is out-of-band for the same reason: the `timeTravel.*` ops
    // are registered unconditionally, so op-registration is not a signal.
    // The honest signal is a bound `TIME_TRAVEL_PORT`.
    if (key === 'timeTravel') return this.container.has(TIME_TRAVEL_PORT);

    // `transfer` ops (export/import) also ship on core against the data source,
    // so the honest signal is the same bound-source-with-models one `data` uses.
    if (key === 'transfer') return this.dataBound();

    // `auth` / `authOrganizations` ops ship on core against `STUDIO_AUTH_SOURCE`
    // (bound by the `@velajs/studio/auth` subpath). Each sub-feature lights on
    // its OWN better-auth capability (admin / organization plugin), independently.
    if (key === 'auth') return this.authCapabilities().admin;
    if (key === 'authOrganizations') return this.authCapabilities().organizations;

    // (a) Studio ships an op for this feature.
    if (registered.has(key)) return true;

    // (b) The app registered entrypoints of a kind this feature owns.
    const kinds = FEATURE_ENTRYPOINT_KINDS[key];
    if (kinds !== undefined && kinds.some((k) => entrypointKinds.has(k))) return true;

    // (c) A probe token for this feature's module is registered.
    const probes = FEATURE_PROBE_TOKENS[key];
    if (probes !== undefined && probes.some((token) => this.container.has(token))) return true;

    return false;
  }

  /**
   * `data` evidence: a `STUDIO_MODEL_SOURCE` is bound (the crud subpath or a BYO
   * source module) AND it discovers ≥1 managed model. Resolving + listing here
   * is safe — capability negotiation runs post-bootstrap and `listModels()` is a
   * pure metadata read (no adapter I/O).
   */
  private dataBound(): boolean {
    if (!this.container.has(STUDIO_MODEL_SOURCE)) return false;
    return this.container.resolve(STUDIO_MODEL_SOURCE).listModels().length > 0;
  }

  /**
   * The bound auth source's capabilities, or both-false when unbound OR the
   * source throws (misconfigured better-auth). Guarded like `timeTravel` so a
   * broken auth source degrades the two auth features to false, never 500s
   * `studio.capabilities`.
   */
  private authCapabilities(): StudioAuthCapabilities {
    if (!this.container.has(STUDIO_AUTH_SOURCE)) return { admin: false, organizations: false };
    try {
      return this.container.resolve(STUDIO_AUTH_SOURCE).capabilities();
    } catch {
      return { admin: false, organizations: false };
    }
  }

  /** Feature keys for which at least one op handler is registered (source (a)). */
  private registeredFeatures(): Set<StudioFeatureKey> {
    const meta = STUDIO_OP_META as Record<string, { feature: StudioFeatureKey }>;
    const out = new Set<StudioFeatureKey>();
    for (const op of this.registry.registeredOps()) {
      const entry = meta[op];
      if (entry !== undefined) out.add(entry.feature);
    }
    return out;
  }

  /** Entrypoint kinds present in THIS app's registry (source (b)); empty when unbuilt. */
  private entrypointKinds(): Set<string> {
    if (!this.container.has(EntrypointRegistry)) return new Set();
    return new Set(this.container.resolve(EntrypointRegistry).kinds());
  }
}
