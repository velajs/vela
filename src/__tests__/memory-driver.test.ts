import { describe, expect, it } from 'vitest';
import { MemoryFlagDriver, memoryFlagDriver } from '../drivers/memory.driver';

describe('MemoryFlagDriver', () => {
  it('returns the caller fallback for unknown keys', async () => {
    const driver = new MemoryFlagDriver();
    expect(driver.name).toBe('memory');
    expect(await driver.getBoolean('missing', true)).toBe(true);
    expect(await driver.getString('missing', 'x')).toBe('x');
    expect(await driver.getNumber('missing', 7)).toBe(7);
    expect(await driver.getObject('missing', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns stored values, seeded from options', async () => {
    const driver = memoryFlagDriver({ values: { flag: false, size: 3, name: 'v2' } });
    expect(await driver.getBoolean('flag', true)).toBe(false);
    expect(await driver.getNumber('size', 0)).toBe(3);
    expect(await driver.getString('name', '')).toBe('v2');
  });

  it('returns the fallback when a stored value has the wrong evaluation type', async () => {
    const driver = memoryFlagDriver({
      values: { boolean: 'true', text: 123, number: true, object: 'not an object', nan: NaN },
    });
    expect(await driver.getBoolean('boolean', false)).toBe(false);
    expect(await driver.getString('text', 'fallback')).toBe('fallback');
    expect(await driver.getNumber('number', 7)).toBe(7);
    expect(await driver.getNumber('nan', 7)).toBe(7);
    expect(await driver.getObject('object', { fallback: true })).toEqual({ fallback: true });
  });

  it('set / delete / reset mutate the store (chainable)', async () => {
    const driver = new MemoryFlagDriver({ values: { a: true } });
    expect(driver.set('b', 'hi').has('b')).toBe(true);
    expect(await driver.getString('b', '')).toBe('hi');

    driver.delete('a');
    expect(driver.has('a')).toBe(false);
    expect(await driver.getBoolean('a', false)).toBe(false);

    driver.reset({ c: 5 });
    expect(driver.has('b')).toBe(false);
    expect(await driver.getNumber('c', 0)).toBe(5);
  });

  it('honors a custom driver name', () => {
    expect(new MemoryFlagDriver({ name: 'experiments' }).name).toBe('experiments');
  });
});
