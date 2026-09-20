import { InjectionToken } from '@velajs/vela';
import type { BetterAuthRuntimeOptions } from './better-auth.types';

export const BETTER_AUTH_OPTIONS = new InjectionToken<BetterAuthRuntimeOptions>(
  'vela.BetterAuthOptions',
);
