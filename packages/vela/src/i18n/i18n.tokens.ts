import { InjectionToken } from '../container/types';
import { RequestContextKey } from '../http/request-context';
import type { I18nModuleOptions } from './i18n.options';

/** Options bag from `I18nModule.forRoot()` (the ConfigurableModuleBuilder options token). */
export const I18N_OPTIONS = /* @__PURE__ */ new InjectionToken<I18nModuleOptions>('I18N_OPTIONS');

/** Key under which the resolved locale is stashed on the per-request RequestContext bag. */
export const I18N_LOCALE_KEY = new RequestContextKey<string>('vela:i18n:locale');
