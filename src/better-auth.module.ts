import {
  defineModule,
  lazyProvider,
  provideGlobal,
  stableHash,
  type DynamicModule,
  type InferTokens,
  type ProviderOptions,
  type Token,
  type Type,
} from '@velajs/vela';
import { createBetterAuthCatchallController } from './better-auth.controller';
import { BetterAuthService, BETTER_AUTH_BUILDER } from './better-auth.service';
import { BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type { BetterAuthInstance, BetterAuthModuleOptions } from './better-auth.types';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionGuard } from './guards/permission.guard';
import { normalizeBetterAuthBasePath } from './base-path';

const referenceIds = new WeakMap<object, number>();
const explicitKeyClaims = new Map<
  string,
  { readonly kind: 'auth' | 'factory'; readonly reference: object; readonly shape: string }
>();
let nextReferenceId = 1;

function referenceId(reference: object): number {
  const existing = referenceIds.get(reference);
  if (existing !== undefined) return existing;
  const id = nextReferenceId++;
  referenceIds.set(reference, id);
  return id;
}

function claimExplicitKey(
  key: string,
  kind: 'auth' | 'factory',
  reference: object,
  shape: string,
): string {
  if (key.length === 0 || key !== key.trim()) {
    throw new Error('@velajs/better-auth: an explicit module key must be a non-empty string');
  }
  const existing = explicitKeyClaims.get(key);
  if (
    existing !== undefined &&
    (existing.kind !== kind || existing.reference !== reference || existing.shape !== shape)
  ) {
    throw new Error(
      `@velajs/better-auth: explicit module key "${key}" is already bound to a different auth registration`,
    );
  }
  explicitKeyClaims.set(key, { kind, reference, shape });
  return `explicit:${key}:ref:${referenceId(reference)}`;
}

/** Structural options with defaults applied (everything but the auth instance). */
interface NormalizedOptions {
  basePath: string;
  issuer: string;
  isGlobal: boolean;
  defaultPolicy: 'deny';
  mountHandler: boolean;
}

function normalize(options: Partial<BetterAuthModuleOptions>): NormalizedOptions {
  const basePath = normalizeBetterAuthBasePath(options.basePath);
  const issuer = options.issuer ?? `better-auth:${basePath}`;
  if (issuer.length === 0 || issuer !== issuer.trim()) {
    throw new Error('@velajs/better-auth: issuer must be a non-empty stable namespace');
  }
  if (options.defaultPolicy !== undefined && options.defaultPolicy !== 'deny') {
    throw new Error(
      '@velajs/better-auth: defaultPolicy is deny-only; mark anonymous routes with @Public() or @OptionalAuth()',
    );
  }
  return {
    basePath,
    issuer,
    isGlobal: options.isGlobal ?? true,
    defaultPolicy: 'deny',
    mountHandler: options.mountHandler ?? true,
  };
}

/** Providers, controllers, and exports shared by both entry points. */
function commonContributions(n: NormalizedOptions): {
  providers: Array<Type | ProviderOptions>;
  controllers: Type[];
  exports: DynamicModule['exports'];
} {
  return {
    providers: [BetterAuthService, AuthGuard, RolesGuard, PermissionGuard],
    controllers: n.mountHandler ? [createBetterAuthCatchallController(n.basePath)] : [],
    exports: [BetterAuthService, BETTER_AUTH_OPTIONS, AuthGuard, RolesGuard, PermissionGuard],
  };
}

/**
 * The blessed engine generates `forRoot`. `setup` runs once per instance at
 * call time: it re-provides {@link BETTER_AUTH_OPTIONS} with defaults applied,
 * derives the auth builder from those options, mounts the catch-all controller,
 * and — via the `global:` slot — registers the app-wide guard when `isGlobal`.
 *
 * `isGlobal` here means "apply AuthGuard app-wide", NOT "make this a global
 * module", so the default `isGlobal → global: true` extras transform is
 * replaced with identity; the flag reaches `setup` through the options bag.
 */
const authModuleHost = defineModule<BetterAuthModuleOptions>({
  name: 'BetterAuth',
  optionsToken: BETTER_AUTH_OPTIONS,
  transform: (definition) => definition,
  // Public entry points always supply an identity-aware key. Keep this fallback
  // for direct host use in tests and future refactors.
  key: (options) => stableHash(normalize(options)),
  setup: ({ OPTIONS, options }) => {
    const n = normalize(options);
    const common = commonContributions(n);
    const auth = (options as BetterAuthModuleOptions).auth;
    return {
      providers: [
        // Override the auto-provided raw bag with the normalized shape so
        // BETTER_AUTH_OPTIONS consumers always see defaults + the auth instance.
        { provide: OPTIONS, useValue: { ...n, auth } },
        // Eager auth: the builder hands back the instance the caller passed in.
        lazyProvider({
          provide: BETTER_AUTH_BUILDER,
          inject: [OPTIONS],
          useFactory: (o: BetterAuthModuleOptions) => o.auth,
        }),
        ...common.providers,
      ],
      controllers: common.controllers,
      exports: common.exports,
      global: n.isGlobal ? { guards: [AuthGuard] } : undefined,
    };
  },
});

/**
 * Options for {@link BetterAuthModule.forRootAsync}.
 *
 * The `Inject` type parameter captures the literal `inject` tuple at the call
 * site (via `const` inference) so `useFactory` parameters are typed from the
 * inject array, position-by-position — no `as const`, no `(...deps: any[])`:
 *
 * ```ts
 * BetterAuthModule.forRootAsync({
 *   inject: [D1Service, ConfigService],   // captured as readonly tuple
 *   useFactory: (d1, config) =>            // d1: D1Service, config: ConfigService
 *     betterAuth({ database: drizzleAdapter(drizzle(d1.database), ...) }),
 * });
 * ```
 */
interface ForRootAsyncOptions<
  Inject extends readonly Token<unknown>[] = readonly Token<unknown>[],
> {
  inject?: Inject;
  imports?: DynamicModule['imports'];
  useFactory: (...deps: InferTokens<Inject>) => BetterAuthInstance;
  isGlobal?: boolean;
  mountHandler?: boolean;
  basePath?: string;
  issuer?: string;
  /** @deprecated Authentication is deny-by-default. Only `'deny'` is accepted. */
  defaultPolicy?: 'deny';
  key?: string;
}

export class BetterAuthModule {
  /**
   * Synchronous registration. The auth instance is constructed by the consumer
   * at module-load time and passed in directly. Use this when the inputs to
   * `betterAuth({...})` are available at startup (Node apps with a static DB
   * connection, in-memory adapters, etc.).
   */
  static forRoot(
    options: BetterAuthModuleOptions & { isGlobal?: boolean; key?: string },
  ): DynamicModule {
    const normalized = normalize(options);
    const shape = stableHash(normalized);
    const key =
      options.key === undefined
        ? `${shape}:auth:${referenceId(options.auth)}`
        : claimExplicitKey(options.key, 'auth', options.auth, shape);
    // Delegate to the generated static, then rebrand the module identity so the
    // public `BetterAuthModule` class is the one registered (consistent with
    // `forRootAsync` and better diagnostics).
    return {
      ...authModuleHost.ConfigurableModuleClass.forRoot({ ...options, key }),
      module: BetterAuthModule,
    };
  }

  /**
   * Deferred / DI-driven registration. The user factory runs **lazily**, on the
   * first time anything reads `BetterAuthService.auth` (or `.api` / `.handler`).
   * In normal request handling that's `AuthGuard.canActivate` or the catch-all
   * controller's `.handle`. At module load the factory does NOT run — it's only
   * captured behind {@link lazyProvider}'s memoized thunk. This is what makes
   * Cloudflare bindings (D1, KV, R2) work: the binding isn't ready at boot, but
   * it IS by the time a request flows through and the guard / catch-all reads
   * the service. Inject deps resolve at module load (cheap BindingRef wrappers);
   * their *values* are read at first auth use, inside your factory body.
   */
  static forRootAsync<const Inject extends readonly Token<unknown>[] = readonly Token<unknown>[]>(
    options: ForRootAsyncOptions<Inject>,
  ): DynamicModule {
    const n = normalize(options);
    const common = commonContributions(n);
    const shape = stableHash({ ...n, inject: options.inject });
    const key =
      options.key === undefined
        ? `${shape}:factory:${referenceId(options.useFactory)}`
        : claimExplicitKey(options.key, 'factory', options.useFactory, shape);
    return {
      module: BetterAuthModule,
      key,
      imports: options.imports ?? [],
      providers: [
        { provide: BETTER_AUTH_OPTIONS, useValue: n },
        // The deferred auth builder: `lazyProvider` wraps the user factory in a
        // memoized thunk, replacing the hand-rolled `(...deps) => () => f(...deps)`.
        lazyProvider({
          provide: BETTER_AUTH_BUILDER,
          inject: options.inject,
          useFactory: options.useFactory,
        }),
        ...common.providers,
        ...(n.isGlobal ? provideGlobal('guard', AuthGuard) : []),
      ],
      controllers: common.controllers,
      exports: common.exports,
    };
  }
}
