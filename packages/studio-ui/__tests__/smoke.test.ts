import { describe, expect, it } from 'vitest';
import { STUDIO_UI_VERSION } from '../src/index';

describe('@velajs/studio-ui', () => {
  it('exposes the ui version marker', () => {
    expect(STUDIO_UI_VERSION).toBe('0');
  });
});
