import type { Flagship } from '@cloudflare/workers-types';
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { FlagshipFlagDriver, flagshipFlagDriver } from '../services/flagship-flag.driver';
import type { FlagshipBinding } from '../services/flagship-flag.driver';

/**
 * A Flagship binding double whose value methods echo the default they receive
 * (exactly like a real binding does on an unresolved key). Individual methods
 * are overridable per test via `.mock*` on the returned spies.
 */
function makeBinding() {
  const getBooleanValue = vi.fn((_k: string, d: boolean, _c?: unknown) => Promise.resolve(d));
  const getStringValue = vi.fn((_k: string, d: string, _c?: unknown) => Promise.resolve(d));
  const getNumberValue = vi.fn((_k: string, d: number, _c?: unknown) => Promise.resolve(d));
  const getObjectValue = vi.fn((_k: string, d: object, _c?: unknown) => Promise.resolve(d));
  const binding = {
    getBooleanValue,
    getStringValue,
    getNumberValue,
    getObjectValue,
  } satisfies FlagshipBinding;
  return { binding, getBooleanValue, getStringValue, getNumberValue, getObjectValue };
}

describe('FlagshipFlagDriver', () => {
  it('defaults its name to "flagship" and accepts an override', () => {
    const { binding } = makeBinding();
    expect(new FlagshipFlagDriver(binding).name).toBe('flagship');
    expect(new FlagshipFlagDriver(binding, { name: 'experiments' }).name).toBe('experiments');
  });

  it('returns the binding value for each type (value hit)', async () => {
    const { binding, getBooleanValue, getStringValue, getNumberValue, getObjectValue } =
      makeBinding();
    getBooleanValue.mockResolvedValueOnce(true);
    getStringValue.mockResolvedValueOnce('v2');
    getNumberValue.mockResolvedValueOnce(42);
    getObjectValue.mockResolvedValueOnce({ theme: 'dark' });
    const driver = new FlagshipFlagDriver(binding);

    expect(await driver.getBoolean('new-checkout', false)).toBe(true);
    expect(await driver.getString('layout', 'v1')).toBe('v2');
    expect(await driver.getNumber('max', 0)).toBe(42);
    expect(await driver.getObject('cfg', {})).toEqual({ theme: 'dark' });
  });

  it('forwards key, fallback and evaluation context to the binding', async () => {
    const { binding, getBooleanValue } = makeBinding();
    const driver = new FlagshipFlagDriver(binding);
    const ctx = { userId: 'u1', plan: 'pro' };

    await driver.getBoolean('new-checkout', false, ctx);
    expect(getBooleanValue).toHaveBeenCalledWith('new-checkout', false, ctx);
  });

  it('returns the fallback the binding echoes for an unresolved key', async () => {
    const { binding } = makeBinding();
    const driver = new FlagshipFlagDriver(binding);
    // The double echoes the default, mirroring a real miss.
    expect(await driver.getString('missing', 'fallback')).toBe('fallback');
  });

  it('propagates a binding error instead of swallowing it', async () => {
    const { binding, getBooleanValue } = makeBinding();
    getBooleanValue.mockRejectedValueOnce(new Error('tunnel dropped'));
    const driver = new FlagshipFlagDriver(binding);

    await expect(driver.getBoolean('new-checkout', false)).rejects.toThrow('tunnel dropped');
  });

  it('resolves the binding lazily through an accessor on every evaluation', async () => {
    const { binding, getBooleanValue } = makeBinding();
    const accessor = vi.fn(() => binding);
    const driver = flagshipFlagDriver(accessor);

    await driver.getBoolean('a', false);
    await driver.getBoolean('b', false);
    expect(accessor).toHaveBeenCalledTimes(2);
    expect(getBooleanValue).toHaveBeenCalledTimes(2);
  });
});

describe('Flagship native details', () => {
  it('forwards each typed native result without losing its metadata', async () => {
    const { binding } = makeBinding();
    const native = {
      ...binding,
      getBooleanDetails: vi.fn(async (flagKey: string) => ({
        flagKey,
        value: true,
        reason: 'TARGETING_MATCH',
        variant: 'enabled',
      })),
      getStringDetails: vi.fn(async (flagKey: string) => ({
        flagKey,
        value: 'safe',
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND',
      })),
      getNumberDetails: vi.fn(async (flagKey: string) => ({
        flagKey,
        value: 4,
        reason: 'SPLIT',
        variant: 'four',
      })),
      getObjectDetails: vi.fn(async (flagKey: string) => ({
        flagKey,
        value: { theme: 'dark' },
        reason: 'DEFAULT',
      })),
    } satisfies FlagshipBinding;
    const driver = new FlagshipFlagDriver(native);
    expect(
      await driver.getBooleanDetails('enabled', false, { userId: 'u1', paid: true, age: 3 }),
    ).toEqual({
      flagKey: 'enabled',
      value: true,
      reason: 'TARGETING_MATCH',
      variant: 'enabled',
    });
    expect(native.getBooleanDetails).toHaveBeenCalledWith('enabled', false, {
      userId: 'u1',
      paid: true,
      age: 3,
    });
    expect(await driver.getStringDetails('layout', 'safe')).toEqual({
      flagKey: 'layout',
      value: 'safe',
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
    expect(await driver.getNumberDetails('limit', 1)).toEqual({
      flagKey: 'limit',
      value: 4,
      reason: 'SPLIT',
      variant: 'four',
    });
    expect(await driver.getObjectDetails('theme', {})).toEqual({
      flagKey: 'theme',
      value: { theme: 'dark' },
      reason: 'DEFAULT',
    });
    expect(binding.getBooleanValue).not.toHaveBeenCalled();
  });

  it('reports UNKNOWN for absent native reasons and bindings without details', async () => {
    const { binding } = makeBinding();
    const driver = new FlagshipFlagDriver(binding);
    expect(await driver.getBooleanDetails('missing', true)).toEqual({
      flagKey: 'missing',
      value: true,
      reason: 'UNKNOWN',
    });
    expect(await driver.getStringDetails('missing', 'safe')).toEqual({
      flagKey: 'missing',
      value: 'safe',
      reason: 'UNKNOWN',
    });
    expect(await driver.getNumberDetails('missing', 3)).toEqual({
      flagKey: 'missing',
      value: 3,
      reason: 'UNKNOWN',
    });
    expect(await driver.getObjectDetails('missing', {})).toEqual({
      flagKey: 'missing',
      value: {},
      reason: 'UNKNOWN',
    });
    const native = new FlagshipFlagDriver({
      ...binding,
      getBooleanDetails: async (flagKey) => ({ flagKey, value: false, errorCode: 'TYPE_MISMATCH' }),
    });
    expect(await native.getBooleanDetails('missing', false)).toEqual({
      flagKey: 'missing',
      value: false,
      reason: 'UNKNOWN',
      errorCode: 'TYPE_MISMATCH',
    });
  });

  it.each([null, {}, [], undefined, NaN, Infinity, -Infinity, 1n])(
    'rejects non-scalar attribute (%#) before native evaluation',
    async (value) => {
      const { binding } = makeBinding();
      const driver = new FlagshipFlagDriver(binding);
      const ctx = { attribute: value };
      expect(await driver.getBooleanDetails('flag', false, ctx)).toEqual({
        flagKey: 'flag',
        value: false,
        reason: 'ERROR',
        errorCode: 'INVALID_CONTEXT',
      });
      expect(() => driver.getBoolean('flag', false, ctx)).toThrow(
        'Invalid Flagship evaluation context',
      );
      expect(binding.getBooleanValue).not.toHaveBeenCalled();
    },
  );

  it('snapshots scalar context and resolves native details lazily', async () => {
    const { binding } = makeBinding();
    const read = vi.fn(
      async (
        flagKey: string,
        _fallback: boolean,
        _ctx?: Record<string, string | number | boolean>,
      ) => ({ flagKey, value: true, reason: 'STATIC' }),
    );
    const accessor = vi.fn(() => ({ ...binding, getBooleanDetails: read }));
    const driver = flagshipFlagDriver(accessor);
    const ctx = { userId: 'u1' };
    await driver.getBooleanDetails('flag', false, ctx);
    ctx.userId = 'u2';
    expect(read.mock.calls[0]?.[2]).toEqual({ userId: 'u1' });
    await driver.getBooleanDetails('flag', false, ctx);
    expect(accessor).toHaveBeenCalledTimes(2);
  });
});

it('accepts the native Workers Flagship binding without an assertion', () => {
  expectTypeOf<Flagship>().toExtend<FlagshipBinding>();
});
