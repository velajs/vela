import type { FeatureFlagDriver, FlagContext } from '@velajs/feature-flags';

/**
 * The subset of a Cloudflare **Flagship** binding this driver evaluates against
 * — the four typed value methods. The binding itself returns the supplied
 * `defaultValue` on evaluation errors; transport-level failures reject and are
 * left to propagate (never-throw is the service layer's job, not the driver's).
 *
 * @see https://developers.cloudflare.com/flagship/binding/
 */
export interface FlagshipBinding {
  getBooleanValue(key: string, defaultValue: boolean, context?: FlagContext): Promise<boolean>;
  getStringValue(key: string, defaultValue: string, context?: FlagContext): Promise<string>;
  getNumberValue(key: string, defaultValue: number, context?: FlagContext): Promise<number>;
  getObjectValue(key: string, defaultValue: object, context?: FlagContext): Promise<unknown>;
}

export interface FlagshipFlagDriverOptions {
  /** Driver name used for `use(name)` / default-driver selection. Default `"flagship"`. */
  name?: string;
}

/**
 * {@link FeatureFlagDriver} backed by a Cloudflare Flagship binding.
 *
 * A thin, honest wrapper: each contract method maps 1:1 onto the binding's
 * corresponding value method, forwarding the caller's `fallback` (the binding's
 * `defaultValue`) and evaluation context. The binding resolves the fallback on
 * evaluation errors; anything the binding *rejects* with (e.g. a `remote: true`
 * dev-proxy tunnel dropping) propagates — `@velajs/feature-flags`'s service owns
 * the never-throw guarantee.
 *
 * Build the driver inside a provider factory with the native environment:
 *
 * ```ts
 * FeatureFlagsModule.forRootAsync({
 *   inject: [ENV],
 *   useFactory: (env: WorkerEnv) => ({ drivers: [flagshipFlagDriver(env.FLAGS)] }),
 * });
 * ```
 *
 * Evaluation ergonomics (the 1:1 binding-method mapping) are ported from the
 * Stratal feature-flags service (MIT, © Temitayo Fadojutimi), reshaped as a
 * bare driver.
 */
export class FlagshipFlagDriver implements FeatureFlagDriver {
  readonly name: string;
  private readonly resolve: () => FlagshipBinding;

  constructor(
    binding: FlagshipBinding | (() => FlagshipBinding),
    options: FlagshipFlagDriverOptions = {},
  ) {
    this.resolve = typeof binding === 'function' ? binding : () => binding;
    this.name = options.name ?? 'flagship';
  }

  getBoolean(key: string, fallback: boolean, ctx?: FlagContext): Promise<boolean> {
    return this.resolve().getBooleanValue(key, fallback, ctx);
  }

  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string> {
    return this.resolve().getStringValue(key, fallback, ctx);
  }

  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number> {
    return this.resolve().getNumberValue(key, fallback, ctx);
  }

  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown> {
    return this.resolve().getObjectValue(key, fallback, ctx);
  }
}

/** Convenience factory for {@link FlagshipFlagDriver}. */
export function flagshipFlagDriver(
  binding: FlagshipBinding | (() => FlagshipBinding),
  options?: FlagshipFlagDriverOptions,
): FlagshipFlagDriver {
  return new FlagshipFlagDriver(binding, options);
}
