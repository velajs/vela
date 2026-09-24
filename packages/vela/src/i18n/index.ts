// @velajs/vela/i18n — message catalogs and locale detection.
import '../metadata';

export { I18nModule } from './i18n.module';
export { I18nService } from './i18n.service';
export { MessageLoaderService } from './message-loader.service';
export { MessageRegistry } from './message-registry';
export { I18nLocaleMiddleware } from './i18n.middleware';
export { I18N_OPTIONS, I18N_LOCALE_KEY } from './i18n.tokens';
export { resolveI18nOptions } from './i18n.options';
export { deepMerge } from './deep-merge';
export type { I18nModuleOptions, ResolvedI18nOptions, DetectionStrategy } from './i18n.options';
export type { II18nService } from './i18n.types';
