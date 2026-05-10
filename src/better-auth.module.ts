import {
  APP_GUARD,
  stableHash,
  type AsyncModuleOptions,
  type DynamicModule,
  type ProviderOptions,
  type Type,
} from '@velajs/vela';
import { BetterAuthCatchallController } from './better-auth.controller';
import { BETTER_AUTH, BETTER_AUTH_OPTIONS } from './better-auth.tokens';
import type { BetterAuthInstance, BetterAuthModuleOptions } from './better-auth.types';
import { AuthGuard } from './guards/auth.guard';
import { RolesGuard } from './guards/roles.guard';

const DEFAULT_BASE_PATH = '/api/auth';

type ForRootAsyncOptions = AsyncModuleOptions<{
  auth: BetterAuthInstance;
  basePath?: string;
  defaultPolicy?: 'deny' | 'allow';
}> & {
  isGlobal?: boolean;
  mountHandler?: boolean;
  key?: string;
};

export class BetterAuthModule {
  static forRoot(options: BetterAuthModuleOptions): DynamicModule {
    const normalized = normalize(options);
    const providers = baseProviders(normalized, options.auth);

    return {
      module: BetterAuthModule,
      key: stableHash({
        basePath: normalized.basePath,
        defaultPolicy: normalized.defaultPolicy,
        isGlobal: !!options.isGlobal,
        mountHandler: !!normalized.mountHandler,
      }),
      providers,
      controllers: normalized.mountHandler ? [BetterAuthCatchallController] : [],
      exports: [BETTER_AUTH, BETTER_AUTH_OPTIONS, AuthGuard, RolesGuard],
    };
  }

  static forRootAsync(options: ForRootAsyncOptions): DynamicModule {
    const mountHandler = options.mountHandler !== false;
    const isGlobal = options.isGlobal === true;

    const optsProvider: ProviderOptions = {
      provide: BETTER_AUTH_OPTIONS,
      useFactory: async (...deps: unknown[]) => {
        const value = await options.useFactory(...deps);
        return {
          auth: value.auth,
          basePath: value.basePath ?? DEFAULT_BASE_PATH,
          defaultPolicy: value.defaultPolicy ?? 'deny',
          isGlobal,
          mountHandler,
        } satisfies BetterAuthModuleOptions;
      },
      inject: options.inject ?? [],
    };

    const authProvider: ProviderOptions = {
      provide: BETTER_AUTH,
      useFactory: (opts: BetterAuthModuleOptions) => opts.auth,
      inject: [BETTER_AUTH_OPTIONS],
    };

    const providers: Array<Type | ProviderOptions> = [
      optsProvider,
      authProvider,
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
        }),
      imports: options.imports ?? [],
      providers,
      controllers: mountHandler ? [BetterAuthCatchallController] : [],
      exports: [BETTER_AUTH, BETTER_AUTH_OPTIONS, AuthGuard, RolesGuard],
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

function baseProviders(
  normalized: Required<BetterAuthModuleOptions>,
  authInstance: BetterAuthInstance,
): Array<Type | ProviderOptions> {
  const providers: Array<Type | ProviderOptions> = [
    { provide: BETTER_AUTH_OPTIONS, useValue: normalized },
    { provide: BETTER_AUTH, useValue: authInstance },
    AuthGuard,
    RolesGuard,
  ];

  if (normalized.isGlobal) {
    providers.push({ provide: APP_GUARD, useExisting: AuthGuard });
  }

  return providers;
}
