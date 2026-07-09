import { METADATA_KEYS, defineMetadata, getMetadata } from '@velajs/vela';
import type { MetaInput } from 'hono-crud';
import type { CrudConfig } from './types';

/**
 * Mark a controller as a CRUD endpoint backed by hono-crud.
 *
 * @example
 * ```ts
 * @Controller('/users')
 * @Crud({ meta: userMeta, adapters: MemoryAdapters })
 * class UserController {
 *   @Override('list')
 *   async customList(c: Context) { ... }
 * }
 * ```
 */
export function Crud<M extends MetaInput = MetaInput>(
  config: CrudConfig<M>,
): ClassDecorator {
  return (target: object) => {
    defineMetadata(METADATA_KEYS.CRUD, config, target);
  };
}

export function getCrudConfig(target: object): CrudConfig | undefined {
  return getMetadata(METADATA_KEYS.CRUD, target) as CrudConfig | undefined;
}
