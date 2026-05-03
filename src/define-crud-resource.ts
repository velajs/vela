import type { Context } from 'hono';
import type { DynamicModule } from '@velajs/vela';
import type { MetaInput } from 'hono-crud';

import { CrudModule } from './crud.module';
import { Override } from './override.decorator';
import type { CrudEndpointName, ResourceConfig } from './types';

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
  overrides?: Partial<
    Record<CrudEndpointName, (c: Context) => unknown | Promise<unknown>>
  >;
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
  const dynamic = CrudModule.forResource(
    path,
    resourceConfig as ResourceConfig<M>,
  );

  if (overrides) {
    const controller = dynamic.controllers?.[0] as
      | (Function & { prototype: Record<string, unknown> })
      | undefined;
    if (controller && controller.prototype) {
      for (const [endpointName, handler] of Object.entries(overrides)) {
        if (!handler) continue;
        const methodName = `__defineCrudResource_${endpointName}`;
        Object.defineProperty(controller.prototype, methodName, {
          configurable: true,
          enumerable: false,
          writable: true,
          value: function (c: Context) {
            return handler(c);
          },
        });
        const descriptor = Object.getOwnPropertyDescriptor(
          controller.prototype,
          methodName,
        )!;
        Override(endpointName as CrudEndpointName)(
          controller.prototype,
          methodName,
          descriptor,
        );
      }
    }
  }

  return dynamic;
}
