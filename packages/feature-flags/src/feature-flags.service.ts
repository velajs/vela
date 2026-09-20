// Never-throw + manifest-default ergonomics adapted from
// @stratal/feature-flags (MIT, © Temitayo Fadojutimi), reshaped from a single
// Cloudflare-binding service into this driver-based, edge-pure form.
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  Scope,
  getCurrentRequestContext,
  type LoggerService,
  type RequestContext,
} from '@velajs/vela';
import type { FeatureFlagDriver } from './drivers/driver';
import type { FeatureFlagDriverRegistry } from './drivers/registry';
import { FEATURE_FLAG_TOKENS } from './feature-flags.tokens';
import type {
  FeatureFlagsOptions,
  FlagContext,
  FlagEvaluationDetails,
  FlagKey,
  FlagManifest,
  FlagValue,
} from './feature-flags.types';

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const TRUSTED_IDENTITY_CONTEXT_KEYS = new Set([
  'userId',
  'tenantId',
  'organizationId',
  'accountId',
  'subject',
  'sub',
]);

/**
 * Safely read the current request context. Returns `undefined` outside a
 * request or when ambient access isn't enabled — never throws — so the service
 * resolves and evaluates in queue / scheduled / global scope too.
 */
function ambientRequestContext(): RequestContext | undefined {
  try {
    return getCurrentRequestContext();
  } catch {
    return undefined;
  }
}

/**
 * The injectable consumers reach for. A thin, type-safe, never-throw wrapper
 * over a {@link FeatureFlagDriver}, with two ergonomic additions:
 *
 * - **Manifest defaults** — omit a default and the value declared in the app's
 *   `manifest` is used (an explicit argument always wins).
 * - **Default context** — the module's `context` resolver is merged into every
 *   evaluation. Per-call targeting attributes may override it, but trusted
 *   identity keys remain sourced from request context. Resolution is skipped
 *   automatically outside request scope.
 *
 * Switch drivers with {@link use}; bind a request with {@link forRequest} (the
 * guard does this). Evaluation NEVER throws — the driver returns the fallback
 * on evaluation errors, and the service additionally absorbs any thrown error
 * into the same fallback with a logged warning.
 *
 * `@Transient`: constructed synchronously (lazy-module-safe), a fresh instance
 * per injection, and resolvable in and out of request scope — it never
 * DI-injects `REQUEST_CONTEXT`, so it does not bubble to request scope.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class FeatureFlagsService {
  private readonly logger: LoggerService;
  private readonly manifest: FlagManifest;
  private readonly driver: FeatureFlagDriver;

  constructor(
    @Inject(FEATURE_FLAG_TOKENS.DriverRegistry)
    private readonly registry: FeatureFlagDriverRegistry,
    @Inject(FEATURE_FLAG_TOKENS.Options) private readonly options: FeatureFlagsOptions,
    @Optional() @Inject(Logger) logger?: LoggerService,
    // The next two are never provided by DI (they carry `@Optional()` so the
    // container leaves them `undefined`). `forRequest()` and `use()` set them
    // when cloning; tests may pass them directly.
    @Optional() private readonly boundContext?: RequestContext,
    @Optional() boundDriver?: FeatureFlagDriver,
  ) {
    this.logger = logger ?? new Logger('FeatureFlags');
    this.manifest = options.manifest ?? {};
    this.driver = boundDriver ?? registry.resolve(options.default);
  }

  /** The name of the driver this instance targets. */
  get driverName(): string {
    return this.driver.name;
  }

  /**
   * Switch to a different registered driver. Returns a NEW immutable instance
   * bound to `name`; the original is unchanged. Throws if `name` is unknown.
   */
  use(name: string): FeatureFlagsService {
    if (name === this.driver.name) return this;
    return this.clone({ driver: this.registry.get(name) });
  }

  /**
   * Bind a request context. Returns a NEW immutable instance whose evaluations
   * merge `options.context(ctx)`. Used by {@link FeatureFlagGuard}; consumers
   * resolved in request scope can also call it explicitly.
   */
  forRequest(ctx: RequestContext): FeatureFlagsService {
    return this.clone({ context: ctx });
  }

  // ==================== EVALUATION ====================

  /** Evaluate a flag as a `boolean`. */
  async getBooleanValue(
    flagKey: FlagKey,
    defaultValue?: boolean,
    context?: FlagContext,
  ): Promise<boolean> {
    const fallback = this.fallback(flagKey, defaultValue, false, isBoolean);
    return this.safe(
      flagKey,
      async () =>
        strictBoolean(
          await this.driver.getBoolean(flagKey, fallback, await this.context(context)),
          flagKey,
        ),
      () => fallback,
    );
  }

  /** Evaluate a flag as a `string`. */
  async getStringValue(
    flagKey: FlagKey,
    defaultValue?: string,
    context?: FlagContext,
  ): Promise<string> {
    const fallback = this.fallback(flagKey, defaultValue, '', isString);
    return this.safe(
      flagKey,
      async () => this.driver.getString(flagKey, fallback, await this.context(context)),
      () => fallback,
    );
  }

  /** Evaluate a flag as a `number`. */
  async getNumberValue(
    flagKey: FlagKey,
    defaultValue?: number,
    context?: FlagContext,
  ): Promise<number> {
    const fallback = this.fallback(flagKey, defaultValue, 0, isNumber);
    return this.safe(
      flagKey,
      async () => this.driver.getNumber(flagKey, fallback, await this.context(context)),
      () => fallback,
    );
  }

  /**
   * Parse an unknown object flag into the parser's result type. A valid typed
   * fallback is required; a driver/context/parser failure returns it unchanged.
   */
  async getObjectValue<T extends object>(
    flagKey: FlagKey,
    parse: (value: unknown) => T,
    fallback: NoInfer<T>,
    context?: FlagContext,
  ): Promise<T> {
    return this.safe(
      flagKey,
      async () =>
        parse(await this.driver.getObject(flagKey, fallback, await this.context(context))),
      () => fallback,
    );
  }

  /** Evaluate a `boolean` flag with synthesized evaluation metadata. */
  async getBooleanDetails(
    flagKey: FlagKey,
    defaultValue?: boolean,
    context?: FlagContext,
  ): Promise<FlagEvaluationDetails<boolean>> {
    const fallback = this.fallback(flagKey, defaultValue, false, isBoolean);
    return this.safe(
      flagKey,
      async () =>
        this.details(
          flagKey,
          strictBoolean(
            await this.driver.getBoolean(flagKey, fallback, await this.context(context)),
            flagKey,
          ),
        ),
      (error) => this.errorDetails(flagKey, fallback, error),
    );
  }

  /** Evaluate a `string` flag with synthesized evaluation metadata. */
  async getStringDetails(
    flagKey: FlagKey,
    defaultValue?: string,
    context?: FlagContext,
  ): Promise<FlagEvaluationDetails<string>> {
    const fallback = this.fallback(flagKey, defaultValue, '', isString);
    return this.safe(
      flagKey,
      async () =>
        this.details(
          flagKey,
          await this.driver.getString(flagKey, fallback, await this.context(context)),
        ),
      (error) => this.errorDetails(flagKey, fallback, error),
    );
  }

  /** Evaluate a `number` flag with synthesized evaluation metadata. */
  async getNumberDetails(
    flagKey: FlagKey,
    defaultValue?: number,
    context?: FlagContext,
  ): Promise<FlagEvaluationDetails<number>> {
    const fallback = this.fallback(flagKey, defaultValue, 0, isNumber);
    return this.safe(
      flagKey,
      async () =>
        this.details(
          flagKey,
          await this.driver.getNumber(flagKey, fallback, await this.context(context)),
        ),
      (error) => this.errorDetails(flagKey, fallback, error),
    );
  }

  /** Evaluate a typed object flag with synthesized evaluation metadata. */
  async getObjectDetails<T extends object>(
    flagKey: FlagKey,
    parse: (value: unknown) => T,
    fallback: NoInfer<T>,
    context?: FlagContext,
  ): Promise<FlagEvaluationDetails<T>> {
    return this.safe(
      flagKey,
      async () =>
        this.details(
          flagKey,
          parse(await this.driver.getObject(flagKey, fallback, await this.context(context))),
        ),
      (error) => this.errorDetails(flagKey, fallback, error),
    );
  }

  /**
   * Evaluate every flag declared in the manifest and return a `{ key: value }`
   * map. The evaluation method is chosen from each declared default's type.
   * A throwing context resolver falls back to the manifest defaults rather than
   * taking the batch down.
   */
  async all(context?: FlagContext): Promise<Record<string, FlagValue>> {
    let merged: FlagContext | undefined;
    try {
      merged = await this.context(context);
    } catch (error) {
      this.logger.warn(
        `Feature flag context resolution failed on driver "${this.driver.name}"; returning manifest defaults.`,
        { error: message(error) },
      );
      return { ...this.manifest };
    }
    const entries = await Promise.all(
      Object.entries(this.manifest).map(
        async ([key, declared]) => [key, await this.evaluate(key, declared, merged)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  // ==================== INTERNAL ====================

  /** Immutable clone with a different driver and/or bound context. */
  private clone(overrides: {
    driver?: FeatureFlagDriver;
    context?: RequestContext;
  }): FeatureFlagsService {
    return new FeatureFlagsService(
      this.registry,
      this.options,
      this.logger,
      overrides.context ?? this.boundContext,
      overrides.driver ?? this.driver,
    );
  }

  /** Resolve the merged evaluation context (default context + per-call override). */
  private async context(callContext?: FlagContext): Promise<FlagContext | undefined> {
    const base = this.boundContext ?? ambientRequestContext();
    if (!this.options.context || !base) return callContext;
    const resolved = await this.options.context(base);
    if (!callContext) return resolved;
    const merged: FlagContext = { ...resolved, ...callContext };
    for (const key of TRUSTED_IDENTITY_CONTEXT_KEYS) {
      if (Object.hasOwn(resolved, key)) merged[key] = resolved[key];
    }
    return merged;
  }

  /** Pick the default: explicit arg, then manifest, then the type's zero value. */
  private fallback<T extends FlagValue>(
    flagKey: string,
    provided: T | undefined,
    zero: T,
    accepts: (value: unknown) => value is T,
  ): T {
    if (provided !== undefined) return provided;
    const declared = Object.hasOwn(this.manifest, flagKey) ? this.manifest[flagKey] : undefined;
    return accepts(declared) ? declared : zero;
  }

  /** Evaluate a single flag, choosing the method from the declared default's type. */
  private evaluate(
    flagKey: string,
    declared: FlagValue,
    context?: FlagContext,
  ): Promise<FlagValue> {
    switch (typeof declared) {
      case 'boolean':
        return this.safe(
          flagKey,
          async () =>
            strictBoolean(await this.driver.getBoolean(flagKey, declared, context), flagKey),
          () => declared,
        );
      case 'number':
        return this.safe(
          flagKey,
          () => this.driver.getNumber(flagKey, declared, context),
          () => declared,
        );
      case 'string':
        return this.safe(
          flagKey,
          () => this.driver.getString(flagKey, declared, context),
          () => declared,
        );
      default:
        return this.safe(
          flagKey,
          async () => {
            const value = await this.driver.getObject(flagKey, declared, context);
            return typeof value === 'object' && value !== null ? value : declared;
          },
          () => declared,
        );
    }
  }

  /**
   * Run an evaluation and absorb any failure into the fallback. A flag lookup
   * must never take the caller down with it.
   */
  private async safe<T>(
    flagKey: string,
    evaluate: () => Promise<T>,
    onError: (error: unknown) => T,
  ): Promise<T> {
    try {
      return await evaluate();
    } catch (error) {
      this.logger.warn(
        `Feature flag evaluation failed for "${flagKey}" on driver "${this.driver.name}"; returning the fallback value.`,
        { error: message(error) },
      );
      return onError(error);
    }
  }

  private details<T extends FlagValue>(flagKey: string, value: T): FlagEvaluationDetails<T> {
    return { flagKey, value, reason: 'STATIC' };
  }

  private errorDetails<T extends FlagValue>(
    flagKey: string,
    value: T,
    error: unknown,
  ): FlagEvaluationDetails<T> {
    return { flagKey, value, reason: 'ERROR', errorMessage: message(error) };
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function strictBoolean(value: unknown, flagKey: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Feature flag "${flagKey}" returned a non-boolean value`);
  }
  return value;
}
