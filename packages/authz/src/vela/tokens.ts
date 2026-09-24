import { InjectionToken } from '@velajs/vela';
import type { Authz, CreateAuthzOptions } from '../authz';

/** Options for {@link AuthzModule}: the engine options plus guard installation. */
export interface AuthzModuleOptions extends CreateAuthzOptions {
  /**
   * `'global'` (default) installs `PermissionGuard` and `RolesGuard` as global
   * guards in the `authorize` phase: after authentication and tenant
   * admission, whatever the import order. Routes without `@RequirePermission`
   * or `@Roles` pass. `'none'` leaves them to `@UseGuards`. With
   * `forRootAsync`, pass it beside the factory.
   */
  guard?: 'global' | 'none';
}

/**
 * The auto-provided options bag passed to {@link AuthzModule}.forRoot. Distinct
 * from {@link AUTHZ} — this token carries the raw {@link AuthzModuleOptions},
 * the built {@link Authz} instance lives under {@link AUTHZ}.
 */
export const AUTHZ_OPTIONS = new InjectionToken<AuthzModuleOptions>('AUTHZ_OPTIONS');

/** The built {@link Authz} instance provided and exported by {@link AuthzModule}. */
export const AUTHZ = new InjectionToken<Authz>('AUTHZ');
