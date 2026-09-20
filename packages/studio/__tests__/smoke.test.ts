import { describe, expect, it } from 'vitest';
import { STUDIO_ADMIN_BASE_PATH } from '../src/index';

describe('@velajs/studio', () => {
  it('reserves the admin base path', () => {
    expect(STUDIO_ADMIN_BASE_PATH).toBe('/_vela/admin');
  });
});
