import { Reflector } from '@velajs/vela';

/**
 * Declares the `@velajs/authz` permission(s) required to reach a controller or
 * route handler. Read via `Reflector` in an authorization guard, then checked
 * against the caller's `Identity` with `authz.can(...)`.
 *
 * ```ts
 * @RequirePermission(['posts:write'])
 * @Post()
 * create() { ... }
 * ```
 *
 * The metadata is a plain `string[]` of permission strings in the granted-side
 * format `@velajs/authz` matches (`resource:action`, or wildcards like
 * `posts:*`). Handler-level metadata overrides class-level (standard
 * `Reflector.getAllAndOverride` precedence).
 *
 * Semantics are **require-ALL** (AND): every listed permission must be granted
 * for access — the `PermissionGuard` denies if any one is missing. This
 * contrasts with `@Roles`, which is **OR** (any one of the listed roles
 * suffices).
 */
export const RequirePermission = Reflector.createDecorator<string[]>({
  key: 'vela.authz.permissions',
});

export const REQUIRE_PERMISSION_KEY = RequirePermission.KEY;
