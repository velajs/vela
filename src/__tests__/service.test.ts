import { Logger, type RequestContext } from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagDriverRegistry } from '../drivers/registry';
import { MemoryFlagDriver } from '../drivers/memory.driver';
import { FeatureFlagsService } from '../feature-flags.service';
import type { FeatureFlagDriver } from '../drivers/driver';
import type { FlagContext, FeatureFlagsOptions } from '../feature-flags.types';

function service(options: FeatureFlagsOptions): FeatureFlagsService {
  return new FeatureFlagsService(buildRegistry(options), options);
}

function buildRegistry(options: FeatureFlagsOptions): FeatureFlagDriverRegistry {
  const drivers =
    options.drivers && options.drivers.length > 0 ? options.drivers : [new MemoryFlagDriver()];
  return new FeatureFlagDriverRegistry(drivers, options.default);
}

/** A driver whose every evaluation rejects — exercises the never-throw seam. */
class ThrowingDriver implements FeatureFlagDriver {
  readonly name = 'throwing';
  getBoolean(): Promise<boolean> {
    return Promise.reject(new Error('binding down'));
  }
  getString(): Promise<string> {
    return Promise.reject(new Error('binding down'));
  }
  getNumber(): Promise<number> {
    return Promise.reject(new Error('binding down'));
  }
  getObject(): Promise<unknown> {
    return Promise.reject(new Error('binding down'));
  }
}

/** A driver that records the evaluation context it was handed. */
class RecordingDriver implements FeatureFlagDriver {
  readonly name = 'recording';
  lastContext: FlagContext | undefined;
  getBoolean(_k: string, fallback: boolean, ctx?: FlagContext): Promise<boolean> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getString(_k: string, fallback: string, ctx?: FlagContext): Promise<string> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getNumber(_k: string, fallback: number, ctx?: FlagContext): Promise<number> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
  getObject(_k: string, fallback: object, ctx?: FlagContext): Promise<unknown> {
    this.lastContext = ctx;
    return Promise.resolve(fallback);
  }
}

const mockRequest = (id: string): RequestContext => ({ id }) as unknown as RequestContext;

const parseTheme = (value: unknown): { theme: string } => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('theme' in value) ||
    typeof value.theme !== 'string'
  ) {
    throw new TypeError('theme must be a string');
  }
  return { theme: value.theme };
};

describe('FeatureFlagsService', () => {
  describe('manifest defaults', () => {
    it('falls back to the declared manifest value when no default arg is given', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver()], // empty store → returns the fallback
        manifest: { 'new-checkout': true, layout: 'v2', limit: 42 },
      });
      expect(await flags.getBooleanValue('new-checkout')).toBe(true);
      expect(await flags.getStringValue('layout')).toBe('v2');
      expect(await flags.getNumberValue('limit')).toBe(42);
    });

    it('an explicit default argument wins over the manifest', async () => {
      const flags = service({ manifest: { 'new-checkout': true } });
      expect(await flags.getBooleanValue('new-checkout', false)).toBe(false);
    });

    it('a stored driver value wins over the manifest default', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { 'new-checkout': false } })],
        manifest: { 'new-checkout': true },
      });
      expect(await flags.getBooleanValue('new-checkout')).toBe(false);
    });

    it('ignores manifest defaults of the wrong primitive type', async () => {
      const flags = service({ manifest: { bool: 'yes', text: false, count: { value: 1 } } });
      expect(await flags.getBooleanValue('bool')).toBe(false);
      expect(await flags.getStringValue('text')).toBe('');
      expect(await flags.getNumberValue('count')).toBe(0);
      expect((await flags.getBooleanDetails('bool')).value).toBe(false);
      expect((await flags.getStringDetails('text')).value).toBe('');
      expect((await flags.getNumberDetails('count')).value).toBe(0);
    });
  });

  describe('parsed object values', () => {
    beforeEach(() => Logger.setWriter(() => {}));
    afterEach(() => Logger.resetWriter());

    it('returns the parser output rather than asserting the stored payload shape', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { layout: { theme: 'dark', extra: 1 } } })],
      });
      expect(await flags.getObjectValue('layout', parseTheme, { theme: 'light' })).toEqual({
        theme: 'dark',
      });
      expect(await flags.getObjectDetails('layout', parseTheme, { theme: 'light' })).toEqual({
        flagKey: 'layout',
        value: { theme: 'dark' },
        reason: 'STATIC',
      });
    });

    it('returns the typed fallback when the object payload fails validation', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { layout: { theme: 42 } } })],
      });
      const fallback = { theme: 'light' };
      expect(await flags.getObjectValue('layout', parseTheme, fallback)).toBe(fallback);
      expect(await flags.getObjectDetails('layout', parseTheme, fallback)).toEqual({
        flagKey: 'layout',
        value: fallback,
        reason: 'ERROR',
        errorMessage: 'theme must be a string',
      });
    });

    it('preserves the fallback on missing flags, driver failures, and context failures', async () => {
      const fallback = { theme: 'light' };
      expect(await service({}).getObjectValue('layout', parseTheme, fallback)).toEqual(fallback);
      const brokenDriver = service({ drivers: [new ThrowingDriver()] });
      expect(await brokenDriver.getObjectValue('layout', parseTheme, fallback)).toBe(fallback);

      const brokenContext = service({
        context: () => {
          throw new Error('context unavailable');
        },
      }).forRequest(mockRequest('r'));
      expect(await brokenContext.getObjectValue('layout', parseTheme, fallback)).toBe(fallback);
    });

    it('merges targeting context before reading an object flag', async () => {
      const driver = new RecordingDriver();
      const flags = service({
        drivers: [driver],
        context: () => ({ plan: 'free', userId: 'u1' }),
      }).forRequest(mockRequest('r'));
      await flags.getObjectValue('layout', parseTheme, { theme: 'light' }, { plan: 'pro' });
      expect(driver.lastContext).toEqual({ plan: 'pro', userId: 'u1' });
    });

    it('allows array-shaped object flags when the parser validates them', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { themes: ['dark', 'light'] } })],
      });
      const parseThemes = (value: unknown): string[] => {
        if (!Array.isArray(value)) throw new TypeError('themes must be an array');
        return value.map((theme: unknown) => {
          if (typeof theme !== 'string') throw new TypeError('theme must be a string');
          return theme;
        });
      };
      expect(await flags.getObjectValue('themes', parseThemes, [])).toEqual(['dark', 'light']);
    });
  });

  describe('never-throw', () => {
    beforeEach(() => Logger.resetWriter());
    afterEach(() => Logger.resetWriter());

    it('absorbs a throwing driver into the fallback and logs a warning', async () => {
      const warnings: string[] = [];
      Logger.setWriter((level, line) => {
        if (level === 'WARN') warnings.push(line);
      });

      const flags = service({
        drivers: [new ThrowingDriver()],
        manifest: { 'new-checkout': true },
      });

      // fallback = manifest default (true), despite the driver rejecting
      expect(await flags.getBooleanValue('new-checkout')).toBe(true);
      // explicit fallback also honored
      expect(await flags.getStringValue('layout', 'safe')).toBe('safe');
      expect(warnings.length).toBeGreaterThanOrEqual(2);
      expect(warnings.some((w) => w.includes('new-checkout') && w.includes('throwing'))).toBe(true);
    });

    it('details synthesize an ERROR reason on failure', async () => {
      Logger.setWriter(() => {});
      const flags = service({ drivers: [new ThrowingDriver()] });
      const details = await flags.getBooleanDetails('x', false);
      expect(details).toMatchObject({ flagKey: 'x', value: false, reason: 'ERROR' });
      expect(details.errorMessage).toContain('binding down');
    });

    it('details synthesize a STATIC reason on success', async () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ values: { x: true } })] });
      expect(await flags.getBooleanDetails('x', false)).toMatchObject({
        flagKey: 'x',
        value: true,
        reason: 'STATIC',
      });
    });
  });

  describe('use() immutability', () => {
    it('returns a new instance bound to another driver, leaving the original untouched', async () => {
      const primary = new MemoryFlagDriver({ name: 'primary', values: { flag: true } });
      const experiments = new MemoryFlagDriver({ name: 'experiments', values: { flag: false } });
      const flags = service({ drivers: [primary, experiments], default: 'primary' });

      const switched = flags.use('experiments');
      expect(switched).not.toBe(flags);
      expect(flags.driverName).toBe('primary');
      expect(switched.driverName).toBe('experiments');
      expect(await flags.getBooleanValue('flag')).toBe(true);
      expect(await switched.getBooleanValue('flag')).toBe(false);
    });

    it('returns the same instance when switching to the current driver', () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ name: 'primary' })] });
      expect(flags.use('primary')).toBe(flags);
    });

    it('throws for an unknown driver name', () => {
      const flags = service({ drivers: [new MemoryFlagDriver({ name: 'primary' })] });
      expect(() => flags.use('nope')).toThrow(/not registered/);
    });
  });

  describe('all()', () => {
    it('evaluates the whole manifest, choosing the method from each declared type', async () => {
      const flags = service({
        drivers: [new MemoryFlagDriver({ values: { bool: false, num: 9 } })],
        manifest: { bool: true, num: 1, str: 'default', obj: { k: 1 } },
      });
      expect(await flags.all()).toEqual({
        bool: false, // from driver
        num: 9, // from driver
        str: 'default', // manifest default (driver has no value)
        obj: { k: 1 },
      });
    });

    it('returns manifest defaults when the context resolver throws', async () => {
      Logger.setWriter(() => {});
      const flags = service({
        drivers: [new MemoryFlagDriver()],
        manifest: { a: true, b: 'x' },
        context: () => {
          throw new Error('ctx boom');
        },
      });
      const bound = flags.forRequest(mockRequest('r'));
      expect(await bound.all()).toEqual({ a: true, b: 'x' });
      Logger.resetWriter();
    });
  });

  describe('context merge', () => {
    it('merges options.context(requestCtx) into every evaluation, per-call overriding', async () => {
      const recording = new RecordingDriver();
      const flags = service({
        drivers: [recording],
        context: (ctx) => ({ userId: ctx.id, plan: 'free' }),
      }).forRequest(mockRequest('user-42'));

      await flags.getBooleanValue('x');
      expect(recording.lastContext).toEqual({ userId: 'user-42', plan: 'free' });

      await flags.getBooleanValue('x', false, { plan: 'pro', extra: 1 });
      expect(recording.lastContext).toEqual({ userId: 'user-42', plan: 'pro', extra: 1 });
    });

    it('skips context when no request is bound (queue/cron/global scope)', async () => {
      const recording = new RecordingDriver();
      const ctxSpy = vi.fn(() => ({ userId: 'x' }));
      const flags = service({ drivers: [recording], context: ctxSpy });

      await flags.getBooleanValue('x');
      expect(ctxSpy).not.toHaveBeenCalled();
      expect(recording.lastContext).toBeUndefined();
    });
  });
});
