import { InjectionToken } from '../container/types';
import type { I18nModuleOptions } from './i18n.options';

/** Options bag from `I18nModule.forRoot()` (the ConfigurableModuleBuilder options token). */
export const I18N_OPTIONS = new InjectionToken<I18nModuleOptions>('I18N_OPTIONS');

/** Key under which the resolved locale is stashed on the per-request RequestContext bag. */
export const I18N_LOCALE_KEY = Symbol.for('vela:i18n:locale');
