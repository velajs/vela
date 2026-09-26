import { InjectionToken } from '@velajs/vela';
import type { Authz, CreateAuthzOptions } from '../authz';

/** Options for the authorization engine provided by {@link AuthzModule}. */
export type AuthzModuleOptions = CreateAuthzOptions;

/**
 * The auto-provided options bag passed to {@link AuthzModule}.forRoot. Distinct
 * from {@link AUTHZ} — this token carries the raw {@link AuthzModuleOptions},
 * the built {@link Authz} instance lives under {@link AUTHZ}.
 */
export const AUTHZ_OPTIONS = new InjectionToken<AuthzModuleOptions>('AUTHZ_OPTIONS');

/** The built {@link Authz} instance provided and exported by {@link AuthzModule}. */
export const AUTHZ = new InjectionToken<Authz>('AUTHZ');
