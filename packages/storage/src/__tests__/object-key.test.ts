import { describe, expect, it } from 'vitest';
import { joinKey, normalizePrefix, stripPrefix } from '../object-key';

describe('storage prefix normalization', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['////', ''],
    ['/tenant/photos/', 'tenant/photos'],
    ['///tenant//photos///', 'tenant//photos'],
    [' tenant ', ' tenant '],
  ])('trims only edge slashes from %j', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected);
  });

  it('preserves long interior slash runs and trims long boundary runs', () => {
    const slashes = '/'.repeat(100_000);
    expect(normalizePrefix(slashes)).toBe('');
    expect(normalizePrefix(`${slashes}tenant${slashes}`)).toBe('tenant');
    const prefix = normalizePrefix(`/tenant${slashes}photos/`);
    expect(prefix).toBe(`tenant${slashes}photos`);
    expect(stripPrefix(prefix, joinKey(prefix, 'image.png'))).toBe('image.png');
  });
});
