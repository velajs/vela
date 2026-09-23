import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Cron,
  Injectable,
  Interval,
  MetadataRegistry,
  Module,
  UseFilters,
  UseGuards,
  VelaFactory,
  type CanActivate,
} from '@velajs/vela';
import { cloudflareAdapter, createCloudflareApp } from '../cloudflare-factory';

const env = {};

beforeEach(() => {
  MetadataRegistry.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Each case uses its own expression: warnings are deduplicated per isolate. */
function jobs(expression: string) {
  @Injectable()
  class Reports {
    @Cron(expression)
    ambiguous() {}
    @Cron(`${expression.replace(/^\d+/, '1')}`, { dialect: 'unix' })
    unix() {}
    @Cron('5 4 * * *', { timeZone: 'local' })
    local() {}
    @Interval(30_000)
    poll() {}
  }
  @Module({ providers: [Reports] })
  class App {}
  return App;
}

describe('schedule diagnostics under the Cloudflare adapter', () => {
  it('warns once per declaration and still boots in the default mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const App = jobs('0 9 * * 1');

    const first = await createCloudflareApp(App, { env });
    const second = await createCloudflareApp(App, { env: {} });
    await Promise.all([first.close(), second.close()]);

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(4);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@Cron\('0 9 \* \* 1'\) on Reports\.ambiguous declares no dialect/),
        expect.stringMatching(/Reports\.unix.*dialect 'unix'.*Cloudflare/),
        expect.stringMatching(/Reports\.local.*timeZone 'local'.*UTC/),
        expect.stringMatching(/@Interval\(30000\) on Reports\.poll.*Workers/),
      ]),
    );
  });

  it('fails bootstrap in throw mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const App = jobs('0 8 * * 2');

    await expect(
      VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })], diagnostics: 'throw' }),
    ).rejects.toThrow(/Reports\.ambiguous declares no dialect/);
  });

  it('stays quiet in silent mode and for portable declarations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const App = jobs('0 7 * * 3');
    const silent = await VelaFactory.create(App, {
      adapters: [cloudflareAdapter({ env })],
      diagnostics: 'silent',
    });
    await silent.close();

    @Injectable()
    class Portable {
      @Cron('0 7 * * 3', { dialect: 'cloudflare' })
      weekly() {}
      @Cron('*/5 * * * *')
      often() {}
    }
    @Module({ providers: [Portable] })
    class PortableApp {}
    const app = await createCloudflareApp(PortableApp, { env });
    await app.close();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once that guards and filters declared for a cron job do not run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class Deny implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }
    class Claim {
      catch(): void {}
    }
    @Injectable()
    @UseGuards(Deny)
    class Exports {
      @Cron('15 2 * * *', { dialect: 'cloudflare' })
      @UseFilters(Claim)
      nightly() {}
    }
    @Module({ providers: [Exports] })
    class App {}

    const first = await createCloudflareApp(App, { env });
    const second = await createCloudflareApp(App, { env: {} });
    await Promise.all([first.close(), second.close()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /@Cron\('15 2 \* \* \*'\) on Exports\.nightly declares @UseGuards and @UseFilters, which do not run.*one that declares guards refuses to run.*signed/,
    );
    await expect(
      VelaFactory.create(App, { adapters: [cloudflareAdapter({ env })], diagnostics: 'throw' }),
    ).rejects.toThrow(/Exports\.nightly declares @UseGuards/);
  });
});
