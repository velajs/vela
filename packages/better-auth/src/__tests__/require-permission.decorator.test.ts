import { RequirePermission } from '@velajs/authz/vela';
import { MetadataRegistry } from '@velajs/vela/module-kit';
import { describe, expect, it } from 'vitest';
import { REQUIRE_PERMISSION_KEY } from '@velajs/authz/vela';

describe('RequirePermission', () => {
  it('uses the stable authz permissions metadata key', () => {
    expect(REQUIRE_PERMISSION_KEY).toBe('vela.authz.permissions');
    expect(RequirePermission.KEY).toBe(REQUIRE_PERMISSION_KEY);
  });

  it('attaches the required permissions as class-level metadata', () => {
    class PostsController {}
    RequirePermission(['posts:read', 'posts:write'])(PostsController);
    expect(MetadataRegistry.getCustomClassMeta(PostsController, REQUIRE_PERMISSION_KEY)).toEqual([
      'posts:read',
      'posts:write',
    ]);
  });

  it('attaches the required permissions as method-level metadata', () => {
    class PostsController {
      remove() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(PostsController.prototype, 'remove');
    if (!descriptor) throw new Error('missing method fixture');
    RequirePermission(['posts:delete'])(PostsController.prototype, 'remove', descriptor);
    expect(
      MetadataRegistry.getCustomHandlerMeta(PostsController, 'remove', REQUIRE_PERMISSION_KEY),
    ).toEqual(['posts:delete']);
  });
});
