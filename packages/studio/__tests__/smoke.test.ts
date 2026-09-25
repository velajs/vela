import { describe, expect, it } from 'vitest';
import { STUDIO_DEFAULT_PATH } from '@velajs/studio-protocol';

describe('@velajs/studio', () => {
  it('reserves the admin base path', () => {
    expect(STUDIO_DEFAULT_PATH).toBe('/_vela/admin');
  });
});
