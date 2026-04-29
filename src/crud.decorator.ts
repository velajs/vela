import { METADATA_KEYS, defineMetadata, getMetadata } from '@velajs/vela';
import type { MetaInput } from 'hono-crud';
import type { CrudConfig } from './types';

/**
 * Mark a controller as a CRUD endpoint backed by hono-crud.
 *
 * The generic `T` is the entity type — used by `@Override` handlers to type
 * their inputs/outputs. It does not constrain the runtime config.
 *
 * @example
 * ```ts
 * @Controller('/users')
 * @Crud<User>({ meta: userMeta, adapters: MemoryAdapters })
 * class UserController {
 *   @Override('list')
 *   async customList(c: Context) { ... }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function Crud<T = unknown, M extends MetaInput = MetaInput>(
  config: CrudConfig<M>,
): ClassDecorator {
  return (target: object) => {
    defineMetadata(METADATA_KEYS.CRUD, config, target);
  };
}

export function getCrudConfig(target: object): CrudConfig | undefined {
  return getMetadata(METADATA_KEYS.CRUD, target) as CrudConfig | undefined;
}
