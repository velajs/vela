import { describe, expect, it } from 'vitest';
import { STUDIO_HOST_VERSION } from '../src/index';

describe('@velajs/studio-host', () => {
  it('exposes the host version marker', () => {
    expect(STUDIO_HOST_VERSION).toBe('0');
  });
});
