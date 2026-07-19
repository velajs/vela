import { describe, expect, it } from 'vitest';
import { stableStringify } from '../src/stable-key';
import { subscriptionKey } from '../src/subscription';

describe('bounded canonical subscription keys', () => {
  it('cannot collide through delimiter characters', () => {
    expect(subscriptionKey('b', 'c', 'a\0x')).not.toBe(subscriptionKey('x\0b', 'c', 'a'));
  });

  it('canonicalizes dangerous own keys without prototype mutation', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":1}') as unknown;
    expect(stableStringify(input)).toBe('{"__proto__":{"polluted":true},"constructor":1}');
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
  });

  it('rejects cycles, non-finite numbers, accessors, and excessive depth', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => stableStringify(cycle)).toThrow();
    expect(() => stableStringify({ value: Number.NaN })).toThrow();
    expect(() =>
      stableStringify(Object.defineProperty({}, 'secret', { get: () => 1, enumerable: true })),
    ).toThrow();
    let deep: unknown = null;
    for (let index = 0; index < 40; index += 1) deep = { deep };
    expect(() => stableStringify(deep)).toThrow(/structural limits/);
  });
});
