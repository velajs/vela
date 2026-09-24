import { InjectionToken } from '../container/types';
import type { SecurityModuleOptions } from './security.types';

export const SECURITY_OPTIONS = /* @__PURE__ */ new InjectionToken<SecurityModuleOptions>(
  'SECURITY_OPTIONS',
);
