/**
 * `@velajs/studio/flags` — the OPTIONAL `@velajs/feature-flags` binding for the
 * flags panel.
 *
 * This subpath is the ONLY module in the package that imports
 * `@velajs/feature-flags`: the core `.` entry never does, so apps without it
 * still mount `StudioModule` and just report the `flags` feature false. An app
 * WITH feature-flags imports `StudioFlagsModule` ALONGSIDE `StudioModule`, which
 * registers the {@link StudioFlagsOps} handlers — the seam that lights the
 * `flags` feature (op-namespace registration; see the M4 features service).
 *
 * The ops reach the flags service through its PUBLIC `FEATURE_FLAG_TOKENS`
 * (`.Service` + `.Options`), resolved PER CALL off the container (lazy-safe,
 * mirroring the dispatch registry). The app must expose `FeatureFlagsModule`
 * app-wide (`forRoot({ isGlobal: true })`) so the service resolves from the
 * Studio dispatch scope; absent ⇒ the ops report `FEATURE_UNCONFIGURED`.
 *
 * Honest degradation: feature-flag DRIVERS have no enumeration API (see the
 * `FlagManifest` doc), so `flags.list` enumerates only the manifest-declared
 * flags (via `service.all()`). `flags.evaluate` picks the typed evaluation
 * method from the flag's declared manifest default; a key absent from the
 * manifest is probed as a boolean (documented — the driver carries no type).
 */
import { Container, Inject, Injectable, defineModule } from '@velajs/vela';
import { FEATURE_FLAG_TOKENS } from '@velajs/feature-flags';
import type {
  FeatureFlagsOptions,
  FeatureFlagsService,
  FlagEvaluationDetails,
  FlagValue as PeerFlagValue,
} from '@velajs/feature-flags';
import type { FlagEvaluation, FlagRow, FlagValue, StudioOpReq } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { studioError } from '../studio.errors';

export const STUDIO_FLAGS_MODULE_ID = 'studio.flags';

@Injectable()
export class StudioFlagsOps {
  constructor(@Inject(Container) private readonly container: Container) {}

  @AdminRpc({ op: 'flags.list' })
  async list(_ctx: AdminOpContext): Promise<FlagRow[]> {
    const all = await this.service().all();
    return Object.entries(all).map(([key, value]) => ({ key, value }));
  }

  @AdminRpc({ op: 'flags.evaluate' })
  async evaluate(
    _ctx: AdminOpContext,
    args: StudioOpReq<'flags.evaluate'>,
  ): Promise<FlagEvaluation> {
    const service = this.service();
    const declared = this.options()?.manifest?.[args.key];
    const details = await this.evaluateByType(service, args.key, declared, args.context);
    return {
      flagKey: details.flagKey,
      value: details.value,
      reason: details.reason,
      ...(details.errorMessage !== undefined ? { errorMessage: details.errorMessage } : {}),
    };
  }

  /** Evaluate `key` with the method matching its declared manifest type (boolean fallback). */
  private evaluateByType(
    service: FeatureFlagsService,
    key: string,
    declared: FlagValue | undefined,
    context: Record<string, unknown> | undefined,
  ): Promise<FlagEvaluationDetails<PeerFlagValue>> {
    switch (typeof declared) {
      case 'number':
        return service.getNumberDetails(key, declared, context);
      case 'string':
        return service.getStringDetails(key, declared, context);
      case 'object':
        return service.getObjectDetails(
          key,
          (value: unknown): object => {
            if (typeof value !== 'object' || value === null)
              throw new Error('Expected an object flag');
            return value;
          },
          declared,
          context,
        );
      case 'boolean':
        return service.getBooleanDetails(key, declared, context);
      default:
        return service.getBooleanDetails(key, undefined, context);
    }
  }

  /** The bound flags service, else `FEATURE_UNCONFIGURED`. */
  private service(): FeatureFlagsService {
    if (!this.container.has(FEATURE_FLAG_TOKENS.Service)) {
      throw studioError(
        'FEATURE_UNCONFIGURED',
        'no FeatureFlagsService is bound (wire FeatureFlagsModule app-wide)',
      );
    }
    return this.container.resolve(FEATURE_FLAG_TOKENS.Service);
  }

  private options(): FeatureFlagsOptions | undefined {
    return this.container.has(FEATURE_FLAG_TOKENS.Options)
      ? this.container.resolve(FEATURE_FLAG_TOKENS.Options)
      : undefined;
  }
}

/** Options for {@link StudioFlagsModule}. Reserved for future flags-panel wiring. */
export type StudioFlagsModuleOptions = Record<string, never>;

const { ConfigurableModuleClass } = defineModule<StudioFlagsModuleOptions>({
  name: 'StudioFlags',
  setup: () => ({ providers: [StudioFlagsOps] }),
});

/**
 * Registers {@link StudioFlagsOps}. Import it with `StudioFlagsModule.forRoot({})`
 * ALONGSIDE `StudioModule` (and `FeatureFlagsModule`) in apps that use
 * feature-flags — this is the seam that lights the `flags` feature.
 */
export class StudioFlagsModule extends ConfigurableModuleClass {}
