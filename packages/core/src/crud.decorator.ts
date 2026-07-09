/**
 * `@Crud(config)` — the native class decorator. Stamps REAL routes, params
 * (with explicit DTO metatypes), route names, and OpenAPI metadata onto the
 * controller at decoration time, in table order (static sub-paths before
 * `/:id`). Method decorators run before class decorators, so hand-written
 * routes on the same controller are always registered ahead of generated
 * ones and can never be shadowed.
 */

import { getMetadata, METADATA_KEYS } from '@velajs/vela';
import { stampCrudRoutes } from './stamp-routes';
import type { CrudConfig } from './crud.types';

export function Crud<Row extends Record<string, unknown> = Record<string, unknown>>(
  config: CrudConfig<Row>,
): ClassDecorator {
  return (target) => {
    stampCrudRoutes(target as unknown as new (...args: never[]) => unknown, config as CrudConfig);
  };
}

/** The `CrudConfig` stamped on a class by `@Crud()`, if any. */
export function getCrudConfig(target: object): CrudConfig | undefined {
  return getMetadata(METADATA_KEYS.CRUD, target) as CrudConfig | undefined;
}
