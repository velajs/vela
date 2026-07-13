import { describe, it, expect, vi } from 'vitest';
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
  } as unknown as FlagshipBinding;
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
