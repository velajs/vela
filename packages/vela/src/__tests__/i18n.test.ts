import { describe, it, expect } from 'vitest';
import { VelaFactory, Module, Controller, Get, Inject, type ModuleImport } from '../index.js';
import { I18nModule, I18nService, MessageLoaderService } from '../i18n/index.js';

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
        I18nModule.forFeature(messages),
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
        I18nModule.forFeature(messages),
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
      imports: [I18nModule.forRoot({ locales: ['en'] }), I18nModule.forFeature(messages)],
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
        I18nModule.forFeature(messages),
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
        I18nModule.forFeature(messages),
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
        I18nModule.forFeature(messages),
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

function messageApplication(...imports: ModuleImport[]) {
  @Module({ imports: [I18nModule.forRoot({ locales: ['en', 'fr'] }), ...imports] })
  class Application {}
  return VelaFactory.create(Application);
}

describe('I18nModule feature ownership', () => {
  it.each([false, true])(
    'isolates applications regardless of first-read order (reverse: %s)',
    async (reverse) => {
      const first = I18nModule.forFeature({ en: { greeting: 'first' } });
      const second = I18nModule.forFeature({ en: { greeting: 'second' } });
      const apps = await Promise.all([messageApplication(first), messageApplication(second)]);
      try {
        for (const index of reverse ? [1, 0] : [0, 1]) {
          const loader = apps[index]!.get(MessageLoaderService);
          expect(loader.translate('en', 'greeting')).toBe(index === 0 ? 'first' : 'second');
        }
        expect(apps[0]!.get(MessageLoaderService)).not.toBe(apps[1]!.get(MessageLoaderService));
      } finally {
        await Promise.all(apps.map((app) => app.close()));
      }
    },
  );

  it('ignores contributions whose returned module is never imported', async () => {
    I18nModule.forFeature({ en: { greeting: 'unimported', private: 'unimported' } });
    const app = await messageApplication(I18nModule.forFeature({ en: { greeting: 'imported' } }));
    try {
      const loader = app.get(MessageLoaderService);
      expect(loader.translate('en', 'greeting')).toBe('imported');
      expect(loader.translate('en', 'private')).toBe('private');
    } finally {
      await app.close();
    }
  });

  it('deep-merges in import order and deduplicates repeated contributions at their first position', async () => {
    // Declaration order is deliberately the opposite of module import order.
    const overrides = I18nModule.forFeature({ en: { section: { title: 'override' } } });
    const defaults = I18nModule.forFeature({
      en: { section: { title: 'default', description: 'description' } },
      fr: { section: { title: 'français' } },
    });
    @Module({ imports: [defaults] })
    class FirstFeature {}
    @Module({ imports: [overrides, defaults] })
    class SecondFeature {}
    const app = await messageApplication(
      FirstFeature,
      SecondFeature,
      I18nModule.forFeature({
        fr: { section: { title: 'français' } },
        en: { section: { description: 'description', title: 'default' } },
      }),
    );
    try {
      const loader = app.get(MessageLoaderService);
      expect(loader.translate('en', 'section.title')).toBe('override');
      expect(loader.translate('en', 'section.description')).toBe('description');
      expect(loader.translate('fr', 'section.title')).toBe('français');
    } finally {
      await app.close();
    }
  });

  it('snapshots caller-owned message values before bootstrap and lazy compilation', async () => {
    const source = { en: { section: { title: 'original' }, values: [1, null, 3] } };
    const feature = I18nModule.forFeature(source);
    source.en.section.title = 'changed before bootstrap';
    source.en.values.push(4);
    const app = await messageApplication(feature);
    try {
      source.en.section.title = 'changed before first read';
      const loader = app.get(MessageLoaderService);
      expect(loader.translate('en', 'section.title')).toBe('original');
      expect(loader.translate('en', 'values')).toBe('1,,3');
    } finally {
      await app.close();
    }
  });

  it('keeps message keys that also name object prototype properties', async () => {
    const app = await messageApplication(
      I18nModule.forFeature({
        en: {
          ['__proto__']: { title: 'prototype message' },
          constructor: { title: 'constructor message' },
        },
      }),
    );
    try {
      const loader = app.get(MessageLoaderService);
      expect(loader.translate('en', '__proto__.title')).toBe('prototype message');
      expect(loader.translate('en', 'constructor.title')).toBe('constructor message');
    } finally {
      await app.close();
    }
  });

  it('reuses a feature declaration across applications without retaining another application’s messages', async () => {
    const shared = I18nModule.forFeature({ en: { greeting: 'shared' } });
    const first = await messageApplication(
      shared,
      I18nModule.forFeature({ en: { greeting: 'first', private: 'first only' } }),
    );
    expect(first.get(MessageLoaderService).translate('en', 'greeting')).toBe('first');
    await first.close();
    const second = await messageApplication(shared);
    try {
      const loader = second.get(MessageLoaderService);
      expect(loader.translate('en', 'greeting')).toBe('shared');
      expect(loader.translate('en', 'private')).toBe('private');
    } finally {
      await second.close();
    }
  });
});
