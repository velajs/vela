import { Reflector } from '@velajs/vela';

/**
 * Declares the `@velajs/authz` permission(s) required to reach a route, enforced
 * by {@link AccessPermissionGuard} against the verified Access identity. The
 * metadata is a plain `string[]` in the granted-side format authz matches
 * (`resource:action`, or wildcards like `posts:*`). Semantics are **require-ALL**
 * (AND): every listed permission must be granted. Handler metadata overrides
 * class metadata (standard `Reflector.getAllAndOverride` precedence).
 *
 * This is a self-owned decorator (its own metadata key) so the Access permission
 * path never depends on `@velajs/better-auth`'s `@RequirePermission`.
 *
 * ```ts
 * @RequireAccessPermission(['posts:write'])
 * @Post()
 * create() {}
 * ```
 */
export const RequireAccessPermission = Reflector.createDecorator<string[]>({
  key: 'vela.cloudflare-access.permissions',
});

export const REQUIRE_ACCESS_PERMISSION_KEY = RequireAccessPermission.KEY;
