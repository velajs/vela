import type { FeatureFlagDriver, FlagContext, FlagEvaluationDetails } from '@velajs/feature-flags';

/**
 * The subset of a Cloudflare **Flagship** binding this driver evaluates against
 * — typed value methods and optional evaluation details. The binding itself returns the supplied
 * `defaultValue` on evaluation errors; transport-level failures reject and are
 * left to propagate (never-throw is the service layer's job, not the driver's).
 *
 * @see https://developers.cloudflare.com/flagship/binding/
 */
type NativeFlagDetails<T> = Omit<FlagEvaluationDetails<T>, 'reason'> & { reason?: string };

export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, string | number | boolean>,
  ): Promise<boolean>;
  getStringValue(
    key: string,
    defaultValue: string,
    context?: Record<string, string | number | boolean>,
  ): Promise<string>;
  getNumberValue(
    key: string,
    defaultValue: number,
    context?: Record<string, string | number | boolean>,
  ): Promise<number>;
  getObjectValue(
    key: string,
    defaultValue: object,
    context?: Record<string, string | number | boolean>,
  ): Promise<unknown>;
  getBooleanDetails?(
    key: string,
    defaultValue: boolean,
    context?: Record<string, string | number | boolean>,
  ): Promise<NativeFlagDetails<boolean>>;
  getStringDetails?(
    key: string,
    defaultValue: string,
    context?: Record<string, string | number | boolean>,
  ): Promise<NativeFlagDetails<string>>;
  getNumberDetails?(
    key: string,
    defaultValue: number,
    context?: Record<string, string | number | boolean>,
  ): Promise<NativeFlagDetails<number>>;
  getObjectDetails?(
    key: string,
    defaultValue: object,
    context?: Record<string, string | number | boolean>,
  ): Promise<NativeFlagDetails<unknown>>;
}

export interface FlagshipFlagDriverOptions {
  /** Driver name used for `use(name)` / default-driver selection. Default `"flagship"`. */
  name?: string;
}

/**
 * {@link FeatureFlagDriver} backed by a Cloudflare Flagship binding.
 *
 * A thin, honest wrapper: each contract method maps 1:1 onto the binding's
 * corresponding native method, forwarding the caller's `fallback` (the binding's
 * `defaultValue`) and validated scalar evaluation context. Optional detail methods
 * preserve native reasons, variants and error codes; value-only bindings report UNKNOWN. The binding resolves the fallback on
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
    return this.resolve().getBooleanValue(key, fallback, nativeContext(ctx));
  }

  getString(key: string, fallback: string, ctx?: FlagContext): Promise<string> {
    return this.resolve().getStringValue(key, fallback, nativeContext(ctx));
  }

  getNumber(key: string, fallback: number, ctx?: FlagContext): Promise<number> {
    return this.resolve().getNumberValue(key, fallback, nativeContext(ctx));
  }

  getObject(key: string, fallback: object, ctx?: FlagContext): Promise<unknown> {
    return this.resolve().getObjectValue(key, fallback, nativeContext(ctx));
  }
  getBooleanDetails(
    key: string,
    fallback: boolean,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<boolean>> {
    return this.details(key, fallback, ctx, (binding, context) =>
      binding.getBooleanDetails
        ? binding.getBooleanDetails(key, fallback, context)
        : binding
            .getBooleanValue(key, fallback, context)
            .then((value) => ({ flagKey: key, value, reason: 'UNKNOWN' })),
    );
  }

  getStringDetails(
    key: string,
    fallback: string,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<string>> {
    return this.details(key, fallback, ctx, (binding, context) =>
      binding.getStringDetails
        ? binding.getStringDetails(key, fallback, context)
        : binding
            .getStringValue(key, fallback, context)
            .then((value) => ({ flagKey: key, value, reason: 'UNKNOWN' })),
    );
  }

  getNumberDetails(
    key: string,
    fallback: number,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<number>> {
    return this.details(key, fallback, ctx, (binding, context) =>
      binding.getNumberDetails
        ? binding.getNumberDetails(key, fallback, context)
        : binding
            .getNumberValue(key, fallback, context)
            .then((value) => ({ flagKey: key, value, reason: 'UNKNOWN' })),
    );
  }

  getObjectDetails(
    key: string,
    fallback: object,
    ctx?: FlagContext,
  ): Promise<FlagEvaluationDetails<unknown>> {
    return this.details(key, fallback, ctx, (binding, context) =>
      binding.getObjectDetails
        ? binding.getObjectDetails(key, fallback, context)
        : binding
            .getObjectValue(key, fallback, context)
            .then((value) => ({ flagKey: key, value, reason: 'UNKNOWN' })),
    );
  }

  private async details<T>(
    key: string,
    fallback: T,
    ctx: FlagContext | undefined,
    read: (
      binding: FlagshipBinding,
      context: Record<string, string | number | boolean> | undefined,
    ) => Promise<NativeFlagDetails<T>>,
  ): Promise<FlagEvaluationDetails<T>> {
    let context: Record<string, string | number | boolean> | undefined;
    try {
      context = nativeContext(ctx);
    } catch {
      return { flagKey: key, value: fallback, reason: 'ERROR', errorCode: 'INVALID_CONTEXT' };
    }
    const details = await read(this.resolve(), context);
    return { ...details, reason: details.reason === undefined ? 'UNKNOWN' : details.reason };
  }
}

/** Convenience factory for {@link FlagshipFlagDriver}. */
export function flagshipFlagDriver(
  binding: FlagshipBinding | (() => FlagshipBinding),
  options?: FlagshipFlagDriverOptions,
): FlagshipFlagDriver {
  return new FlagshipFlagDriver(binding, options);
}

/** Copy only validated scalar attributes; never coerce nested or non-finite values. */
function nativeContext(
  ctx: FlagContext | undefined,
): Record<string, string | number | boolean> | undefined {
  if (ctx === undefined) return undefined;
  if (
    ctx === null ||
    typeof ctx !== 'object' ||
    Array.isArray(ctx) ||
    (Object.getPrototypeOf(ctx) !== Object.prototype && Object.getPrototypeOf(ctx) !== null)
  )
    throw new TypeError('Invalid Flagship evaluation context');
  const entries: [string, string | number | boolean][] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new TypeError('Invalid Flagship evaluation context');
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
