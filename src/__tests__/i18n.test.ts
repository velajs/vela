import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Module, Controller, Get, Inject, MetadataRegistry } from '../index.js';
import { I18nModule, I18nService, MessageRegistry } from '../i18n/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
  MessageRegistry.reset();
});

const messages = {
  en: {
    greeting: 'Hello, {name}!',
    items: '{count, plural, one {# item} other {# items}}',
  },
  fr: {
    greeting: 'Bonjour, {name} !',
  },
};

describe('I18nModule', () => {
  it('translates using the Accept-Language locale with ICU params', async () => {
    @Controller('hi')
    class HiController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { msg: string; locale: string } {
        return { msg: this.i18n.t('greeting', { name: 'Ada' }), locale: this.i18n.getLocale() };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({ defaultLocale: 'en', locales: ['en', 'fr'] }),
        I18nModule.registerMessages(messages),
      ],
      controllers: [HiController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const en = await hono.request('/hi', { headers: { 'accept-language': 'en' } });
    expect(await en.json()).toEqual({ msg: 'Hello, Ada!', locale: 'en' });

    const fr = await hono.request('/hi', { headers: { 'accept-language': 'fr' } });
    expect(await fr.json()).toEqual({ msg: 'Bonjour, Ada !', locale: 'fr' });
  });

  it('falls back to the default locale for unsupported locales; unknown keys return the key', async () => {
    @Controller('t')
    class TController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { locale: string; missing: string } {
        return { locale: this.i18n.getLocale(), missing: this.i18n.t('nope.key') };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({ defaultLocale: 'en', locales: ['en', 'fr'] }),
        I18nModule.registerMessages(messages),
      ],
      controllers: [TController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/t', { headers: { 'accept-language': 'de' } });
    expect(await res.json()).toEqual({ locale: 'en', missing: 'nope.key' });
  });

  it('supports ICU plural formatting', async () => {
    @Controller('n')
    class NController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { one: string; many: string } {
        return {
          one: this.i18n.t('items', { count: 1 }),
          many: this.i18n.t('items', { count: 3 }),
        };
      }
    }

    @Module({
      imports: [I18nModule.forRoot({ locales: ['en'] }), I18nModule.registerMessages(messages)],
      controllers: [NController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/n', { headers: { 'accept-language': 'en' } });
    expect(await res.json()).toEqual({ one: '1 item', many: '3 items' });
  });

  it('falls back to fallbackLocale for keys missing in a supported locale', async () => {
    @Controller('fb')
    class FbController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { greeting: string; items: string } {
        // fr has `greeting` but not `items`; items should fall back to en.
        return {
          greeting: this.i18n.t('greeting', { name: 'Ada' }),
          items: this.i18n.t('items', { count: 2 }),
        };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({ defaultLocale: 'en', fallbackLocale: 'en', locales: ['en', 'fr'] }),
        I18nModule.registerMessages(messages),
      ],
      controllers: [FbController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/fb', { headers: { 'accept-language': 'fr' } });
    expect(await res.json()).toEqual({ greeting: 'Bonjour, Ada !', items: '2 items' });
  });

  it('honors Accept-Language q-values and is case-insensitive', async () => {
    @Controller('al')
    class AlController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { locale: string } {
        return { locale: this.i18n.getLocale() };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({ defaultLocale: 'en', locales: ['en', 'fr'] }),
        I18nModule.registerMessages(messages),
      ],
      controllers: [AlController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    // Lower q on fr => en wins despite appearing second.
    const q = await hono.request('/al', { headers: { 'accept-language': 'fr;q=0.1, en' } });
    expect(await q.json()).toEqual({ locale: 'en' });

    // Uppercase tag matches the configured lowercase locale.
    const caseInsensitive = await hono.request('/al', { headers: { 'accept-language': 'FR' } });
    expect(await caseInsensitive.json()).toEqual({ locale: 'fr' });
  });

  it('does not crash on a malformed locale cookie (falls back to default)', async () => {
    @Controller('ck')
    class CkController {
      constructor(@Inject(I18nService) private readonly i18n: I18nService) {}
      @Get()
      handle(): { locale: string } {
        return { locale: this.i18n.getLocale() };
      }
    }

    @Module({
      imports: [
        I18nModule.forRoot({
          defaultLocale: 'en',
          locales: ['en', 'fr'],
          detection: { strategy: 'cookie' },
        }),
        I18nModule.registerMessages(messages),
      ],
      controllers: [CkController],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/ck', { headers: { cookie: 'locale=%' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locale: 'en' });
  });
});
