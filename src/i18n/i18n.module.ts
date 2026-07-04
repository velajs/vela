import type { DynamicModule } from '../module/types';
import { Module } from '../module/decorators';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { stableHash } from '../module/stable-hash';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import { I18nLocaleMiddleware } from './i18n.middleware';
import type { I18nModuleOptions } from './i18n.options';
import { I18nService } from './i18n.service';
import { I18N_OPTIONS } from './i18n.tokens';
import { MessageLoaderService } from './message-loader.service';
import { MessageRegistry } from './message-registry';

const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<I18nModuleOptions>({
  moduleName: 'I18n',
  optionsInjectionToken: I18N_OPTIONS,
}).build();

// Empty marker module for `registerMessages`. The contribution is a side-effect
// on the global MessageRegistry; this carries NO providers so it never
// duplicates I18nModule's providers (which would trip vela's multi-instance
// encapsulation → MultipleProvidersFoundError). New modules whose contribution
// is providers (not an external registry) should use `sideEffectModule` from
// the authoring kit; this predates it and keeps a shared-class identity so
// identical message trees dedup as one module instance.
@Module({})
class I18nMessagesModule {}

@Module({
  // Lazy: the merged-message snapshot (MessageLoaderService constructor) and
  // locale middleware materialize on the first request that reaches them —
  // message registration itself is import-time and unaffected. Safe because
  // the route-build priority probe skips lazy-pending APP_MIDDLEWARE tokens.
  lazy: true,
  providers: [
    MessageRegistry,
    MessageLoaderService,
    I18nService,
    I18nLocaleMiddleware,
    // Register the locale middleware globally (NestJS APP_MIDDLEWARE convention).
    { provide: APP_MIDDLEWARE, useExisting: I18nLocaleMiddleware },
  ],
  exports: [I18nService, MessageLoaderService, I18N_OPTIONS],
})
export class I18nModule extends ConfigurableModuleClass {
  /**
   * forFeature-style: contribute a message tree (`{ [locale]: { ...messages } }`).
   * Contributions are collected statically at module-load and deep-merged.
   */
  static registerMessages(messages: Record<string, Record<string, unknown>>): DynamicModule {
    MessageRegistry.addMessages(messages);
    return { module: I18nMessagesModule, key: `messages:${stableHash(messages)}`, providers: [] };
  }
}
