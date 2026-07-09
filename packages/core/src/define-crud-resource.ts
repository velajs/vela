import type { Context } from 'hono';
import type { DynamicModule, Type } from '@velajs/vela';
import type { MetaInput } from 'hono-crud';

import { CrudModule } from './crud.module';
import { Override } from './override.decorator';
import type { CrudEndpointName, ResourceConfig } from './types';

type CrudOverrideHandler = (c: Context) => unknown | Promise<unknown>;

/**
 * Config for {@link defineCrudResource}. Extends {@link ResourceConfig} with a
 * required `path` and an optional `overrides` map. Each override is applied via
 * the same `@Override` decorator a hand-written controller would use; the
 * resulting `DynamicModule` is indistinguishable from one produced by
 * `CrudModule.forResource()` plus method-level decorators.
 */
export interface DefineCrudResourceConfig<M extends MetaInput = MetaInput>
  extends ResourceConfig<M> {
  path: string;
  overrides?: Partial<Record<CrudEndpointName, CrudOverrideHandler>>;
}

/**
 * Ergonomic helper that bundles `CrudModule.forResource(path, config)` with
 * programmatic per-endpoint override application. The returned `DynamicModule`
 * has the same shape as one constructed via `CrudModule.forResource(...)`
 * combined with `@Override` on the controller class — registration, guards,
 * and override middleware all flow through the existing infrastructure.
 *
 * @example
 * ```ts
 * const userResource = defineCrudResource({
 *   path: '/users',
 *   meta: userMeta,
 *   adapters: MemoryAdapters,
 *   only: ['list', 'create'],
 *   overrides: {
 *     list: (c) => c.json({ items: store.all() }),
 *   },
 * });
 *
 * @Module({ imports: [userResource] })
 * class AppModule {}
 * ```
 */
export function defineCrudResource<M extends MetaInput = MetaInput>(
  config: DefineCrudResourceConfig<M>,
): DynamicModule {
  const { path, overrides, ...resourceConfig } = config;
  const dynamic = CrudModule.forResource(path, resourceConfig);

  if (!overrides) return dynamic;
  const controller = dynamic.controllers?.[0];
  if (!controller) return dynamic;

  for (const [endpoint, handler] of Object.entries(overrides)) {
    if (!handler) continue;
    attachOverrideMethod(controller, endpoint as CrudEndpointName, handler);
  }

  return dynamic;
}

/**
 * Install a synthetic method on the controller's prototype and tag it with the
 * `@Override` metadata so the regular CRUD pipeline picks it up. The synthetic
 * method matches the shape of a hand-written class method (configurable,
 * writable, non-enumerable) and wraps the handler so `this` is dropped at the
 * call seam.
 */
function attachOverrideMethod(
  controller: Type,
  endpoint: CrudEndpointName,
  handler: CrudOverrideHandler,
): void {
  const methodName = `__defineCrudResource_${endpoint}`;
  const value = function (c: Context) {
    return handler(c);
  };
  Object.defineProperty(controller.prototype, methodName, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
  // `Override()` reads only (target, propertyKey); the descriptor arg is
  // required by `MethodDecorator`'s signature but ignored.
  Override(endpoint)(controller.prototype, methodName, { value });
}
