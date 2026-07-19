import { InjectionToken } from '@velajs/vela';
import type { BetterAuthModuleOptions } from './better-auth.types';

export const BETTER_AUTH_OPTIONS = new InjectionToken<BetterAuthModuleOptions>(
  'vela.BetterAuthOptions',
);

export const AUTH_USER_KEY = Symbol.for('vela.better-auth.user');
export const AUTH_SESSION_KEY = Symbol.for('vela.better-auth.session');
export const AUTH_ISSUER_KEY = Symbol.for('vela.better-auth.issuer');
export const AUTH_PRINCIPAL_TYPE_KEY = Symbol.for('vela.better-auth.principal-type');
