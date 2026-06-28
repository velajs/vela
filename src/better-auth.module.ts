import {
  APP_GUARD,
  stableHash,
  type DynamicModule,
  type InferTokens,
  type ProviderOptions,
  type Token,
  type Type,
} from '@velajs/vela';
import { createBetterAuthCatchallController } from './better-auth.controller';
import {
  BetterAuthService,
  BETTER_AUTH_BUILDER,
} from './better-auth.service';
import { BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type { BetterAuthInstance, BetterAuthModuleOptions } from './better-auth.types';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';

const DEFAULT_BASE_PATH = '/api/auth';

/**
 * Options for {@link BetterAuthModule.forRootAsync}.
 *
 * The `Inject` type parameter captures the literal `inject` tuple at the
 * call site (via `const` inference on the consuming generic) so
 * `useFactory` parameters are typed from the inject array, position-by-position.
 * No `as const`, no `(...deps: any[])` workaround:
 *
 * ```ts
 * BetterAuthModule.forRootAsync({
 *   inject: [D1Service, ConfigService],   // captured as readonly tuple
 *   useFactory: (d1, config) =>             // d1: D1Service, config: ConfigService
 *     betterAuth({ database: drizzleAdapter(drizzle(d1.database), ...) }),
 * });
 * ```
 *
 * When `inject` isn't a literal tuple (or is omitted), `Inject` falls back
 * to `readonly Token<unknown>[]` and `useFactory` accepts variadic
 * `unknown[]` — the historical loose-typing behavior.
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
  defaultPolicy?: 'deny' | 'allow';
  key?: string;
}

export class BetterAuthModule {
  /**
   * Synchronous registration. The auth instance is constructed by the
   * consumer at module-load time and passed in directly. Use this when the
   * inputs to `betterAuth({...})` are available at startup (Node apps with
   * a static DB connection, in-memory adapters, etc.).
   */
  static forRoot(options: BetterAuthModuleOptions): DynamicModule {
    const normalized = normalize(options);
    const providers = buildProviders(normalized, () => options.auth);

    return {
      module: BetterAuthModule,
      key: stableHash({
        basePath: normalized.basePath,
        defaultPolicy: normalized.defaultPolicy,
        isGlobal: !!options.isGlobal,
        mountHandler: !!normalized.mountHandler,
      }),
      providers,
      controllers: normalized.mountHandler
        ? [createBetterAuthCatchallController(normalized.basePath)]
        : [],
      exports: [BetterAuthService, BETTER_AUTH_OPTIONS, AuthGuard, RolesGuard],
    };
  }

  /**
   * Deferred / DI-driven registration. The user factory runs **lazily**, on
   * the first time anything reads `BetterAuthService.auth` (or `.api` /
   * `.handler`). In normal request handling, that's `AuthGuard.canActivate`
   * or the catch-all controller's `.handle`. At module load, the factory
   * does NOT run — it's only captured as a closure inside the builder
   * thunk. This is what makes Cloudflare bindings (D1, KV, R2) work: the
   * binding isn't ready at boot, but it IS by the time a request flows
   * through and the guard / catch-all reads the service.
   *
   * Inject deps are resolved at module load (cheap; e.g. D1Service is a
   * thin BindingRef wrapper). Their *values* are read at first auth use,
   * inside your factory body — `(d1: D1Service) => betterAuth({ database:
   * drizzleAdapter(drizzle(d1.database), ...) })`.
   */
  static forRootAsync<
    const Inject extends readonly Token<unknown>[] = readonly Token<unknown>[],
  >(options: ForRootAsyncOptions<Inject>): DynamicModule {
    const mountHandler = options.mountHandler !== false;
    const isGlobal = options.isGlobal === true;
    const basePath = options.basePath ?? DEFAULT_BASE_PATH;
    const defaultPolicy = options.defaultPolicy ?? 'deny';

    const providers: Array<Type | ProviderOptions> = [
      {
        provide: BETTER_AUTH_OPTIONS,
        useValue: {
          basePath,
          defaultPolicy,
          isGlobal,
          mountHandler,
        } as Omit<BetterAuthModuleOptions, 'auth'>,
      },
      {
        // The builder is a zero-arg closure capturing the DI'd deps. It is
        // invoked lazily by BetterAuthService.auth on first access; vela
        // can resolve this provider at module load without running the user
        // factory — the factory body lives behind the closure.
        //
        // The inner factory is typed `unknown[]` (vela's runtime contract:
        // deps are resolved by token order). The outer user-facing
        // `options.useFactory` is statically typed via `InferTokens<Inject>`.
        // We narrow at the boundary with a single cast — runtime order
        // matches the declared `inject` order by construction.
        provide: BETTER_AUTH_BUILDER,
        useFactory: (...deps: unknown[]) =>
          () =>
            (options.useFactory as (...d: unknown[]) => BetterAuthInstance)(...deps),
        inject: options.inject ?? [],
      },
      BetterAuthService,
      AuthGuard,
      RolesGuard,
    ];

    if (isGlobal) {
      providers.push({ provide: APP_GUARD, useExisting: AuthGuard });
    }

    return {
      module: BetterAuthModule,
      key:
        options.key ??
        stableHash({
          inject: options.inject,
          isGlobal,
          mountHandler,
          basePath,
          defaultPolicy,
        }),
      imports: options.imports ?? [],
      providers,
      controllers: mountHandler ? [createBetterAuthCatchallController(basePath)] : [],
      exports: [BetterAuthService, BETTER_AUTH_OPTIONS, AuthGuard, RolesGuard],
    };
  }
}

function normalize(options: BetterAuthModuleOptions): Required<BetterAuthModuleOptions> {
  return {
    auth: options.auth,
    basePath: options.basePath ?? DEFAULT_BASE_PATH,
    isGlobal: options.isGlobal ?? false,
    defaultPolicy: options.defaultPolicy ?? 'deny',
    mountHandler: options.mountHandler ?? true,
  };
}

function buildProviders(
  normalized: Required<BetterAuthModuleOptions>,
  builder: () => BetterAuthInstance,
): Array<Type | ProviderOptions> {
  const providers: Array<Type | ProviderOptions> = [
    { provide: BETTER_AUTH_OPTIONS, useValue: normalized },
    { provide: BETTER_AUTH_BUILDER, useValue: builder },
    BetterAuthService,
    AuthGuard,
    RolesGuard,
  ];

  if (normalized.isGlobal) {
    providers.push({ provide: APP_GUARD, useExisting: AuthGuard });
  }

  return providers;
}
