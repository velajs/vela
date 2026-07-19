import { describe, expect, it } from 'vitest';
import { STUDIO_PROTOCOL_VERSION } from '../src/index';

describe('@velajs/studio-protocol', () => {
  it('exposes the protocol version marker', () => {
    expect(STUDIO_PROTOCOL_VERSION).toBe('0');
  });
});
