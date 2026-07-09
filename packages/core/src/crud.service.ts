import type { MetaInput } from 'hono-crud';
import type { AdapterBundle } from 'hono-crud/config';

/**
 * Abstract base for CRUD services. Subclasses bind a hono-crud `AdapterBundle`
 * and (optionally) a `meta` so they can be injected via Vela's DI container
 * and consumed by `@Crud({ service })`.
 *
 * @example
 * ```ts
 * import { MemoryAdapters, defineMeta, defineModel } from 'hono-crud';
 *
 * @Injectable()
 * class UserService extends CrudService<User> {
 *   readonly meta = defineMeta({ model: defineModel({ tableName: 'users', schema: UserSchema, primaryKeys: ['id'] }) });
 *   readonly adapters = MemoryAdapters;
 * }
 * ```
 *
 * The generic `T` is the entity type, used by `@Crud<T>()` to type
 * `@Override` handlers.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export abstract class CrudService<T = unknown> {
  abstract readonly adapters: AdapterBundle;
  abstract readonly meta: MetaInput;
}
