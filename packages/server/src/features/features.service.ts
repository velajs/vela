import { Container, Inject, Injectable } from '@velajs/vela';
import { STUDIO_OPS, STUDIO_OP_META } from '@velajs/studio-protocol';
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
import { STUDIO_LIVE_SOURCE } from '../live/live.port';

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
    return {
      app: registered.has('app'),
      openapi: this.config.rootModule !== undefined,
      data: this.dataBound(),
      transfer: this.dataBound(),
      timeTravel: this.timeTravelCapabilities() !== null,
      auth: this.authCapabilities().admin,
      authOrganizations: this.authCapabilities().organizations,
      queue: registered.has('queue'),
      schedule: registered.has('schedule'),
      flags: registered.has('flags'),
      live: registered.has('live') && this.liveBound(),
      presence: registered.has('presence') && this.liveBound(),
      logs: registered.has('logs'),
      audit: registered.has('audit'),
    };
  }

  /** The full capability descriptor returned by `studio.capabilities`. */
  capabilities(): StudioCapabilities {
    const features = this.features();
    const registered = new Set(this.registry.registeredOps());
    return {
      features,
      operations: STUDIO_OPS.filter(
        (op) =>
          registered.has(op) &&
          features[STUDIO_OP_META[op].feature] &&
          op !== 'queue.depths' &&
          op !== 'queue.dlq' &&
          op !== 'queue.replay',
      ),
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

  /**
   * `data` evidence: a `STUDIO_MODEL_SOURCE` is bound (the crud subpath or a BYO
   * source module) AND it discovers ≥1 managed model. Resolving + listing here
   * is safe — capability negotiation runs post-bootstrap and `listModels()` is a
   * pure metadata read (no adapter I/O).
   */
  private dataBound(): boolean {
    if (!this.container.has(STUDIO_MODEL_SOURCE)) return false;
    try {
      return this.container.resolve(STUDIO_MODEL_SOURCE).listModels().length > 0;
    } catch {
      return false;
    }
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

  private liveBound(): boolean {
    if (!this.container.has(STUDIO_LIVE_SOURCE)) return false;
    try {
      return this.container.resolve(STUDIO_LIVE_SOURCE) !== undefined;
    } catch {
      return false;
    }
  }

  /** Feature keys for which at least one op handler is registered (source (a)). */
  private registeredFeatures(): Set<StudioFeatureKey> {
    const registered = new Set(this.registry.registeredOps());
    const out = new Set<StudioFeatureKey>();
    for (const op of STUDIO_OPS) {
      if (registered.has(op)) out.add(STUDIO_OP_META[op].feature);
    }
    return out;
  }
}
