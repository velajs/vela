import { describe, it, expect, vi } from 'vitest';
import { KvFlagDriver, kvFlagDriver } from '../services/kv-flag.driver';

/**
 * Map-backed KV double storing JSON strings, mirroring the KVCacheStore test
 * fake. Only `namespace.get(key, 'json')` is exercised by the driver.
 */
function fakeKVService(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) store.set(k, JSON.stringify(v));
  const get = vi.fn(async (key: string, type?: 'json') => {
    const raw = store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  });
  const namespace = { get };
  return { service: namespace as unknown as KVNamespace, store, get };
}

describe('KvFlagDriver', () => {
  it('defaults its name to "kv" and accepts an override', () => {
    const { service } = fakeKVService();
    expect(new KvFlagDriver(service).name).toBe('kv');
    expect(new KvFlagDriver(service, { name: 'kv-flags' }).name).toBe('kv-flags');
  });

  it('returns the stored value for each type (value hit)', async () => {
    const { service } = fakeKVService({
      'new-checkout': true,
      layout: 'v2',
      'max-uploads': 5,
      config: { theme: 'dark' },
    });
    const driver = new KvFlagDriver(service);

    expect(await driver.getBoolean('new-checkout', false)).toBe(true);
    expect(await driver.getString('layout', 'v1')).toBe('v2');
    expect(await driver.getNumber('max-uploads', 0)).toBe(5);
    expect(await driver.getObject('config', {})).toEqual({ theme: 'dark' });
  });

  it('returns the caller fallback for a missing key', async () => {
    const { service } = fakeKVService();
    const driver = new KvFlagDriver(service);

    expect(await driver.getBoolean('nope', true)).toBe(true);
    expect(await driver.getString('nope', 'x')).toBe('x');
    expect(await driver.getNumber('nope', 7)).toBe(7);
    expect(await driver.getObject('nope', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns the fallback when the stored JSON is the wrong type', async () => {
    const { service } = fakeKVService({
      num: 5,
      bool: true,
      str: 'hi',
      obj: { a: 1 },
    });
    const driver = new KvFlagDriver(service);

    expect(await driver.getBoolean('num', false)).toBe(false); // number, wanted boolean
    expect(await driver.getString('num', 'x')).toBe('x'); // number, wanted string
    expect(await driver.getNumber('bool', 9)).toBe(9); // boolean, wanted number
    expect(await driver.getObject('str', { fallback: true })).toEqual({ fallback: true }); // string, wanted object
    expect(await driver.getNumber('obj', 3)).toBe(3); // object, wanted number
  });

  it('does not treat a stored JSON null as an object', async () => {
    const { service } = fakeKVService({ nulled: null });
    const driver = new KvFlagDriver(service);

    expect(await driver.getObject('nulled', { a: 1 })).toEqual({ a: 1 });
  });

  it('reads under a configurable key prefix', async () => {
    const { service, get } = fakeKVService({ 'ff:new-checkout': true });
    const driver = kvFlagDriver(service, { prefix: 'ff:' });

    expect(await driver.getBoolean('new-checkout', false)).toBe(true);
    expect(get).toHaveBeenCalledWith('ff:new-checkout', 'json');
  });

  it('propagates a KV error instead of swallowing it', async () => {
    const { service, get } = fakeKVService();
    get.mockRejectedValueOnce(new Error('kv down'));
    const driver = new KvFlagDriver(service);

    await expect(driver.getBoolean('new-checkout', false)).rejects.toThrow('kv down');
  });
});
