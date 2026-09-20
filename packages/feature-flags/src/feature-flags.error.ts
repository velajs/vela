/**
 * The single error type for `@velajs/feature-flags`.
 *
 * Note: flag *evaluation* never throws — the service absorbs driver failures
 * into the fallback value (see {@link FeatureFlagsService}). `FeatureFlagError`
 * is reserved for *configuration* faults surfaced at wiring time: an unknown
 * driver name, a duplicate driver, or an empty driver set.
 */
export class FeatureFlagError extends Error {
  override name = 'FeatureFlagError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
  }
}
