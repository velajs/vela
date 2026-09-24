import { APP_GUARD, defineProvider, type DynamicModule, type Token, type Type } from '@velajs/vela';
import {
  lazyProvider,
  stableHash,
  type FactoryInject,
  type InferTokens,
} from '@velajs/vela/module-kit';
import { createBetterAuthCatchallController } from './better-auth.controller';
import { BetterAuthService, BETTER_AUTH_BUILDER } from './better-auth.service';
import { BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type {
  BetterAuthInstance,
  BetterAuthModuleOptions,
  BetterAuthRuntimeOptions,
} from './better-auth.types';
import { AuthGuard } from './guards/auth.guard';
import { normalizeBetterAuthBasePath } from './base-path';

const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 1;

function referenceId(reference: object): number {
  const existing = referenceIds.get(reference);
  if (existing !== undefined) return existing;
  const id = nextReferenceId++;
  referenceIds.set(reference, id);
  return id;
}

/**
 * An explicit key names a registration without widening its identity: the
 * options shape and auth reference stay in the module key, so the same
 * registration deduplicates within an application while a different one
 * (including a root rebuilt per environment) becomes its own instance. No
 * process-wide state is kept, so repeated bootstraps in one isolate succeed.
 */
function explicitKey(key: string, shape: string, reference: object): string {
  if (key.length === 0 || key !== key.trim()) {
    throw new Error('@velajs/better-auth: an explicit module key must be a non-empty string');
  }
  return `explicit:${key}:${shape}:ref:${referenceId(reference)}`;
}

/** Structural options with defaults applied (everything but the auth instance). */
interface NormalizedOptions {
  basePath: string;
  issuer: string;
  guard: 'global' | 'none';
  mountHandler: boolean;
}

function normalize(options: BetterAuthRuntimeOptions): NormalizedOptions {
  const guard = options.guard ?? 'global';
  if (guard !== 'global' && guard !== 'none') {
    throw new Error("@velajs/better-auth: guard must be 'global' or 'none'");
  }
  const basePath = normalizeBetterAuthBasePath(options.basePath);
  const issuer = options.issuer ?? `better-auth:${basePath}`;
  if (issuer.length === 0 || issuer !== issuer.trim()) {
    throw new Error('@velajs/better-auth: issuer must be a non-empty stable namespace');
  }
  return {
    basePath,
    issuer,
    guard,
    mountHandler: options.mountHandler ?? true,
  };
}

/** AuthGuard as a global guard; it declares the `authenticate` phase. */
function globalGuard(n: NormalizedOptions): NonNullable<DynamicModule['providers']> {
  return n.guard === 'global' ? [defineProvider(APP_GUARD, { useExisting: AuthGuard })] : [];
}

/** Providers, controllers, and exports shared by both entry points. */
function commonContributions(n: NormalizedOptions): {
  providers: NonNullable<DynamicModule['providers']>;
  controllers: Type[];
  exports: DynamicModule['exports'];
} {
  return {
    providers: [BetterAuthService, AuthGuard],
    controllers: n.mountHandler ? [createBetterAuthCatchallController(n.basePath)] : [],
    exports: [BetterAuthService, BETTER_AUTH_OPTIONS, AuthGuard],
  };
}

/**
 * Options for {@link BetterAuthModule.forRootAsync}.
 *
 * The `Inject` type parameter captures the literal `inject` tuple at the call
 * site (via `const` inference) so `useFactory` parameters are typed from the
 * inject array, position-by-position — no `as const`, no `(...deps: any[])`:
 *
 * ```ts
 * BetterAuthModule.forRootAsync({
 *   inject: [ENV, ConfigService],         // captured as readonly tuple
 *   useFactory: (env, config) =>          // inferred from the tokens
 *     betterAuth({ database: drizzleAdapter(drizzle(env.DB), ...) }),
 * });
 * ```
 *
 * A factory without parameters may omit `inject`.
 */
type ForRootAsyncOptions<Inject extends readonly Token[] = readonly Token[]> = {
  imports?: DynamicModule['imports'];
  useFactory: (...deps: InferTokens<Inject>) => BetterAuthInstance;
  guard?: 'global' | 'none';
  mountHandler?: boolean;
  basePath?: string;
  issuer?: string;
  key?: string;
} & FactoryInject<Inject>;

export class BetterAuthModule {
  /**
   * Synchronous registration. The auth instance is constructed by the consumer
   * at module-load time and passed in directly. Use this when the inputs to
   * `betterAuth({...})` are available at startup (Node apps with a static DB
   * connection, in-memory adapters, etc.).
   */
  static forRoot(options: BetterAuthModuleOptions & { key?: string }): DynamicModule {
    const normalized = normalize(options);
    const shape = stableHash(normalized);
    const key =
      options.key === undefined
        ? `${shape}:auth:${referenceId(options.auth)}`
        : explicitKey(options.key, shape, options.auth);
    const common = commonContributions(normalized);
    return {
      module: BetterAuthModule,
      key,
      providers: [
        defineProvider(BETTER_AUTH_OPTIONS, { useValue: normalized }),
        defineProvider(BETTER_AUTH_BUILDER, { useValue: () => options.auth }),
        ...common.providers,
        ...globalGuard(normalized),
      ],
      controllers: common.controllers,
      exports: common.exports,
    };
  }

  /**
   * Deferred / DI-driven registration. The user factory runs **lazily**, on the
   * first time anything reads `BetterAuthService.auth` (or `.api` / `.handler`).
   * In normal request handling that's `AuthGuard.canActivate` or the catch-all
   * controller's `.handle`. At module load the factory does NOT run — it's only
   * captured in the checked builder provider. The Workers adapter supplies its
   * native environment before DI; the lazily constructed auth instance belongs
   * to that environment's application and never captures another app's bindings.
   */
  static forRootAsync<const Inject extends readonly Token[] = readonly Token[]>(
    options: ForRootAsyncOptions<Inject>,
  ): DynamicModule {
    const n = normalize(options);
    const common = commonContributions(n);
    const shape = stableHash({ ...n, inject: options.inject });
    const key =
      options.key === undefined
        ? `${shape}:factory:${referenceId(options.useFactory)}`
        : explicitKey(options.key, shape, options.useFactory);
    return {
      module: BetterAuthModule,
      key,
      imports: options.imports ?? [],
      providers: [
        defineProvider(BETTER_AUTH_OPTIONS, { useValue: n }),
        // Unmemoized: BetterAuthService caches the instance it builds.
        lazyProvider<BetterAuthInstance, Inject>({
          ...options,
          provide: BETTER_AUTH_BUILDER,
          memoize: false,
        }),
        ...common.providers,
        ...globalGuard(n),
      ],
      controllers: common.controllers,
      exports: common.exports,
    };
  }
}
