import { InjectionToken } from '@velajs/vela';
import type { Authz, CreateAuthzOptions } from '../authz';

/**
 * The auto-provided options bag passed to {@link AuthzModule}.forRoot. Distinct
 * from {@link AUTHZ} — this token carries the raw {@link CreateAuthzOptions},
 * the built {@link Authz} instance lives under {@link AUTHZ}.
 */
export const AUTHZ_OPTIONS = new InjectionToken<CreateAuthzOptions>('AUTHZ_OPTIONS');

/** The built {@link Authz} instance provided and exported by {@link AuthzModule}. */
export const AUTHZ = new InjectionToken<Authz>('AUTHZ');
