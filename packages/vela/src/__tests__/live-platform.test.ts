import { describe, expect, it } from 'vitest';
import { Module, VelaFactory, defineProvider } from '../index.js';
import type { RuntimeAdapter } from '../module-kit.js';
import { WebSocketModule } from '../websocket/index.js';
import {
  InMemoryCursorLog,
  LIVE_CURSOR_LOG,
  LIVE_DRIVER,
  LIVE_PLATFORM,
  LiveInvalidation,
  LiveModule,
  localLive,
  type LiveDriver,
  type LivePlatform,
} from '../live/index.js';

/** A platform with its own default driver and log that records what it adopts. */
class RecordingPlatform implements LivePlatform {
  readonly bound: LiveDriver[] = [];
  readonly driver = localLive();
  readonly log = new InMemoryCursorLog();

  liveDriver(): LiveDriver {
    return this.driver;
  }
  cursorLog(): InMemoryCursorLog {
    return this.log;
  }
  bindDriver(driver: LiveDriver): void {
    this.bound.push(driver);
  }
}

function platformAdapter(platform: LivePlatform): RuntimeAdapter {
  return {
    name: 'test-live-platform',
    configureContainer(container) {
      container.register(defineProvider(LIVE_PLATFORM, { useValue: platform }));
      container.markGlobalToken(LIVE_PLATFORM);
    },
  };
}

describe('LiveModule platform defaults', () => {
  it("uses the platform's driver and cursor log when the options name none", async () => {
    const platform = new RecordingPlatform();
    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [platformAdapter(platform)] });
    try {
      expect(app.get(LIVE_DRIVER)).toBe(platform.driver);
      expect(app.get(LIVE_CURSOR_LOG)).toBe(platform.log);
      expect(platform.bound).toEqual([platform.driver]);
    } finally {
      await app.close();
    }
  });

  it('prefers configured factories and still hands the configured driver to the platform', async () => {
    const platform = new RecordingPlatform();
    const configured = localLive();
    const log = new InMemoryCursorLog();
    @Module({
      imports: [
        WebSocketModule.forRoot(),
        LiveModule.forRoot({ driver: async () => configured, log: () => log }),
      ],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { adapters: [platformAdapter(platform)] });
    try {
      expect(app.get(LIVE_DRIVER)).toBe(configured);
      expect(app.get(LIVE_CURSOR_LOG)).toBe(log);
      expect(platform.bound).toEqual([configured]);
      await expect(app.get(LiveInvalidation).invalidate({ tags: ['a'] })).resolves.toMatchObject({
        cursor: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('delivers locally with an in-memory log without a platform', async () => {
    @Module({ imports: [WebSocketModule.forRoot(), LiveModule.forRoot()] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    try {
      expect(app.get(LIVE_DRIVER).kind).toBe('local');
      expect(app.get(LIVE_CURSOR_LOG)).toBeInstanceOf(InMemoryCursorLog);
    } finally {
      await app.close();
    }
  });
});
