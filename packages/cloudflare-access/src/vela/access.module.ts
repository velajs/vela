import { defineModule, defineProvider } from '@velajs/vela';
import { createAccessResolver, type CreateAccessResolverOptions } from '../resolver';
import { CloudflareAccessGuard } from './access.guard';
import {
  ACCESS_MODULE_OPTIONS,
  ACCESS_RESOLVER,
  type CloudflareAccessModuleOptions,
} from './tokens';

/**
 * Derive the core resolver options from the module options, omitting absent
 * optionals (the core options use `exactOptionalPropertyTypes`).
 */
const toResolverOptions = (
  options: CloudflareAccessModuleOptions,
): CreateAccessResolverOptions => ({
  preset: options.preset,
  aud: options.aud,
  ...(options.tenantClaim === undefined ? {} : { tenantClaim: options.tenantClaim }),
  ...(options.mapClaims === undefined ? {} : { mapClaims: options.mapClaims }),
  ...(options.groupRoles === undefined ? {} : { groupRoles: options.groupRoles }),
  ...(options.identity === undefined ? {} : { identity: options.identity }),
  ...(options.clockToleranceSec === undefined
    ? {}
    : { clockToleranceSec: options.clockToleranceSec }),
  ...(options.keySet === undefined ? {} : { keySet: options.keySet }),
  ...(options.onError === undefined ? {} : { onError: options.onError }),
});

/**
 * Built on `@velajs/vela`'s `defineModule` (the same pattern as `AuthzModule`).
 * `defineModule` mints `forRoot`/`forRootAsync` and auto-provides the options bag
 * under {@link ACCESS_MODULE_OPTIONS}. The resolver is built through a **factory**
 * that injects {@link ACCESS_MODULE_OPTIONS} rather than reading the setup-time
 * `options` bag — `forRootAsync` resolves the real options only at resolution
 * time, so the factory sees the full, resolved bag in both `forRoot` and
 * `forRootAsync`. The resolver token is exported so an app can inject it and
 * compose it with other resolvers.
 */
const { ConfigurableModuleClass } = defineModule<CloudflareAccessModuleOptions>({
  name: 'CloudflareAccess',
  optionsToken: ACCESS_MODULE_OPTIONS,
  setup: ({ options }) => {
    const guard = options.guard ?? 'global';
    if (guard !== 'global' && guard !== 'none')
      throw new TypeError("CloudflareAccessModule guard must be 'global' or 'none'");
    return {
      providers: [
        defineProvider(ACCESS_RESOLVER, {
          useFactory: (resolved: CloudflareAccessModuleOptions) =>
            createAccessResolver(toResolverOptions(resolved)),
          inject: [ACCESS_MODULE_OPTIONS],
        }),
        ...(guard === 'none' ? [CloudflareAccessGuard] : []),
      ],
      exports: [ACCESS_RESOLVER, ACCESS_MODULE_OPTIONS, CloudflareAccessGuard],
      global: guard === 'global' ? { guards: [CloudflareAccessGuard] } : {},
    };
  },
});

/**
 * Vela module for `@velajs/cloudflare-access`. Read the Access team domain and
 * audience from the application's `ENV`:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     CloudflareAccessModule.forRootAsync({
 *       inject: [ENV],
 *       useFactory: (env) => ({
 *         preset: cloudflareAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN),
 *         aud: env.CF_ACCESS_AUD,
 *         groupRoles: { 'idp-editors': ['editor'] },
 *       }),
 *     }),
 *   ],
 * })
 * class AppModule {}
 * ```
 */
export class CloudflareAccessModule extends ConfigurableModuleClass {}
