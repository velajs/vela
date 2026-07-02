import { Scope } from '../constants';
import { Inject, Injectable } from '../container/decorators';
import { REQUEST_CONTEXT, type RequestContext } from '../http/request-context';
import type { I18nModuleOptions } from './i18n.options';
import { I18N_LOCALE_KEY, I18N_OPTIONS } from './i18n.tokens';
import type { II18nService } from './i18n.types';
import { MessageLoaderService } from './message-loader.service';

/**
 * Request-scoped translation facade. Reads the locale resolved by
 * {@link I18nLocaleMiddleware} from the per-request RequestContext.
 *
 * Injecting it into a controller/service is safe: vela's request-scope bubbling
 * promotes the consumer to request scope automatically, so no captive-dependency
 * hazard and no `ambientContainer` flag required.
 */
@Injectable({ scope: Scope.REQUEST })
export class I18nService implements II18nService {
  constructor(
    @Inject(MessageLoaderService) private readonly loader: MessageLoaderService,
    @Inject(REQUEST_CONTEXT) private readonly ctx: RequestContext,
    @Inject(I18N_OPTIONS) private readonly options: I18nModuleOptions,
  ) {}

  t(key: string, params?: Record<string, unknown>): string {
    return this.loader.translate(this.getLocale(), key, params);
  }

  getLocale(): string {
    return this.ctx.get<string>(I18N_LOCALE_KEY) ?? this.options.defaultLocale ?? 'en';
  }
}
