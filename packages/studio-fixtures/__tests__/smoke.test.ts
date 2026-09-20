import { describe, expect, it } from 'vitest';
import { STUDIO_FIXTURES_VERSION } from '../src/index';

describe('@velajs/studio-fixtures', () => {
  it('exposes the fixtures version marker', () => {
    expect(STUDIO_FIXTURES_VERSION).toBe('0');
  });
});
