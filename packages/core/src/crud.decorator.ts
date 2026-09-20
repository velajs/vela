/**
 * `@Crud(config)` — the native class decorator. Stamps REAL routes, params
 * (with explicit DTO metatypes), route names, and OpenAPI metadata onto the
 * controller at decoration time, in table order (static sub-paths before
 * `/:id`). Method decorators run before class decorators, so hand-written
 * routes on the same controller are always registered ahead of generated
 * ones and can never be shadowed.
 */

import type { ZodRawShape } from 'zod';
import { stampCrudRoutes } from './stamp-routes';
import {
  compileCrudConfig,
  registeredCrudConfig,
  type CrudConfig,
  type RuntimeCrudConfig,
} from './crud.types';

export function Crud<Shape extends ZodRawShape>(config: CrudConfig<Shape>) {
  const runtime = compileCrudConfig(config);
  return <T extends { new (...args: never[]): unknown; readonly prototype: object }>(
    target: T,
  ): T => {
    stampCrudRoutes(target, runtime);
    return target;
  };
}

/** The validated runtime configuration registered when the class is decorated. */
export function getCrudConfig(target: object): RuntimeCrudConfig | undefined {
  return registeredCrudConfig(target);
}
