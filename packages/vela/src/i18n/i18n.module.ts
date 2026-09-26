import { defineProvider } from '../container/types';
import type { DynamicModule } from '../module/types';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { attachModuleIdentity } from '../module/module-fingerprints';
import { stableHash } from '../module/stable-hash';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import { I18nLocaleMiddleware } from './i18n.middleware';
import type { I18nModuleOptions } from './i18n.options';
import { I18nService } from './i18n.service';
import { I18N_OPTIONS } from './i18n.tokens';
import { MessageLoaderService } from './message-loader.service';
import { MessageRegistry } from './message-registry';
import { MessageContributionRecord, snapshotMessages } from './message-contribution';

const { ConfigurableModuleClass } = defineModule<I18nModuleOptions>({
  name: 'I18n',
  optionsToken: I18N_OPTIONS,
});

// A separate owner contributes messages without duplicating I18n's services.
@Module({})
class I18nMessagesModule {}

@Module({
  // Lazy: the merged-message snapshot (MessageLoaderService constructor) and
  // locale middleware materialize on the first request that reaches them.
  // Imported feature records are already registered in this application's graph.
  lazy: true,
  providers: [
    MessageRegistry,
    MessageLoaderService,
    I18nService,
    I18nLocaleMiddleware,
    // Register the locale middleware globally (NestJS APP_MIDDLEWARE convention).
    defineProvider(APP_MIDDLEWARE, { useExisting: I18nLocaleMiddleware }),
  ],
  exports: [I18nService, MessageLoaderService, I18N_OPTIONS],
})
export class I18nModule extends ConfigurableModuleClass {
  /**
   * Contribute a message tree (`{ [locale]: { ...messages } }`) to this
   * application's imported module graph. Later imports override earlier leaves;
   * repeated identical imports contribute once, at their first position.
   */
  static forFeature(messages: Record<string, Record<string, unknown>>): DynamicModule {
    const snapshot = snapshotMessages(messages);
    return attachModuleIdentity(
      {
        module: I18nMessagesModule,
        key: `messages:${stableHash(snapshot)}`,
        providers: [
          defineProvider(MessageContributionRecord, {
            useValue: new MessageContributionRecord(snapshot),
          }),
        ],
      },
      { messages: snapshot },
    );
  }
}
