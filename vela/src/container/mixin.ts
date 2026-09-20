import { Injectable } from './decorators';
import type { Type } from './types';

/**
 * Creates a reusable injectable mixin class from a base class.
 * Applies @Injectable() so the returned class can be registered as a provider.
 *
 * @example
 * ```ts
 * function RoleGuardMixin(role: string) {
 *   class MixedRoleGuard implements CanActivate {
 *     canActivate(ctx: ExecutionContext) {
 *       return ctx.getRequest().headers.get('x-role') === role;
 *     }
 *   }
 *   return mixin(MixedRoleGuard);
 * }
 *
 * const AdminGuard = RoleGuardMixin('admin');
 *
 * @UseGuards(AdminGuard)
 * @Get('/admin')
 * adminOnly() { ... }
 * ```
 */
export function mixin<T>(mixinClass: Type<T>): Type<T> {
  Injectable()(mixinClass);
  return mixinClass;
}
