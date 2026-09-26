import { defineModule, defineProvider, InjectionToken, type Type } from '@velajs/vela';
import { createBetterAuthCatchallController } from './better-auth.controller';
import { BetterAuthService, BETTER_AUTH_BUILDER } from './better-auth.service';
import { BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type {
  BetterAuthInstance,
  BetterAuthModuleOptions,
  BetterAuthRuntimeOptions,
  BetterAuthStructuralOption,
} from './better-auth.types';
import { AuthGuard } from './guards/auth.guard';
import { DEFAULT_BETTER_AUTH_BASE_PATH, normalizeBetterAuthBasePath } from './base-path';

const MODULE_OPTIONS = new InjectionToken<BetterAuthModuleOptions>(
  'vela.better-auth.ModuleOptions',
);

/** Runtime options with defaults applied: what AuthGuard and the upgrade authenticator read. */
function runtimeOptions(options: BetterAuthModuleOptions): Required<BetterAuthRuntimeOptions> {
  const auth: unknown = options.auth;
  if (typeof auth !== 'function' && (typeof auth !== 'object' || auth === null)) {
    throw new TypeError(
      '@velajs/better-auth: options need `auth`, a better-auth instance or a function that builds one',
    );
  }
  const basePath = normalizeBetterAuthBasePath(options.basePath);
  const issuer = options.issuer ?? `better-auth:${basePath}`;
  if (issuer.length === 0 || issuer !== issuer.trim()) {
    throw new Error('@velajs/better-auth: issuer must be a non-empty stable namespace');
  }
  return {
    basePath,
    issuer,
    mountHandler: options.mountHandler ?? true,
  };
}

/** The instance itself, or the one its builder function returns. */
function buildAuth(auth: BetterAuthModuleOptions['auth']): BetterAuthInstance {
  return typeof auth === 'function' ? auth() : auth;
}

const { ConfigurableModuleClass } = defineModule<
  BetterAuthModuleOptions,
  BetterAuthStructuralOption
>({
  name: 'BetterAuth',
  optionsToken: MODULE_OPTIONS,
  structural: ['basePath', 'mountHandler'],
  // Spelling out a default configures what leaving it out does: one instance.
  defaults: { basePath: DEFAULT_BETTER_AUTH_BASE_PATH, mountHandler: true },
  setup: ({ OPTIONS, options }) => {
    // Validates the mount path when the module is declared, before bootstrap.
    const basePath = normalizeBetterAuthBasePath(options.basePath);
    const controllers: Type[] =
      options.mountHandler === false ? [] : [createBetterAuthCatchallController(basePath)];
    return {
      providers: [
        defineProvider(BETTER_AUTH_OPTIONS, {
          useFactory: (resolved) => runtimeOptions(resolved),
          inject: [OPTIONS],
        }),
        // BetterAuthService calls the builder on first use and caches the
        // instance, so a builder function never runs at bootstrap.
        defineProvider(BETTER_AUTH_BUILDER, {
          useFactory: (resolved) => () => buildAuth(resolved.auth),
          inject: [OPTIONS],
        }),
        BetterAuthService,
        AuthGuard,
      ],
      controllers,
      exports: [BetterAuthService, BETTER_AUTH_OPTIONS, AuthGuard],
    };
  },
});

/**
 * better-auth for Vela: `BetterAuthService`, the catch-all handler under
 * `basePath`, and an injectable `AuthGuard`. Applications install it through `APP_GUARD`
 * with `useExisting: AuthGuard`, or attach it with `@UseGuards`.
 *
 * ```ts
 * BetterAuthModule.forRoot({ auth: betterAuth({ ... }) });
 * BetterAuthModule.forRootAsync({
 *   inject: [ENV],
 *   useFactory: (env) => ({ auth: () => betterAuth({ database: env.DB }), issuer: 'accounts' }),
 * });
 * ```
 *
 * `basePath` and `mountHandler` are structural: `forRootAsync`
 * takes them alongside the factory. The factory runs when the application
 * initializes; an `auth` function it returns runs on first authentication.
 */
export class BetterAuthModule extends ConfigurableModuleClass {}
