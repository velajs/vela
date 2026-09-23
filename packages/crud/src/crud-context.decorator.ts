/**
 * `@CrudCtx()` — param decorator for `@Override` handlers and custom routes:
 * yields the raw Hono context plus the request-scoped child container (plain
 * `@Inject(Container)` would give the root).
 */

import type { Context } from 'hono';
import { createParamDecorator } from '@velajs/vela';
import { getRequestContainer } from '@velajs/vela/module-kit';

export interface CrudRequestContext {
  c: Context;
  /** The request-scoped child container (request-scoped hook/policy DI). */
  container: ReturnType<typeof getRequestContainer>;
}

export const CrudCtx = createParamDecorator((_data, ctx): CrudRequestContext => {
  const c = ctx.getContext();
  return { c, container: getRequestContainer(c) };
});
