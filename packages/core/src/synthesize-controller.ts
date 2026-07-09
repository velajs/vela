/**
 * Headless resources: `CrudModule.forFeature([{ path, model, ... }])`
 * synthesizes a controller class per resource — no hand-written class needed.
 * The synthesized class goes through the exact same stamping as a decorated
 * one, so `vela route list`, `urlFor`, OpenAPI, and the pipeline see no
 * difference.
 */

import { Controller, type Type } from '@velajs/vela';
import { resourceNames, type CrudConfig } from './crud.types';
import { stampCrudRoutes } from './stamp-routes';

export interface CrudFeatureResource<
  Row extends Record<string, unknown> = Record<string, unknown>,
> extends CrudConfig<Row> {
  /** Mount path for the resource's routes (`'/users'`). */
  path: string;
}

const pascal = (s: string): string =>
  s.replace(/(?:^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());

export function synthesizeController(feature: CrudFeatureResource): Type {
  const { path, ...config } = feature;
  const names = resourceNames(config);

  const cls = class {};
  // NamedEvaluation idiom: a stable class name for stack traces, route list,
  // and OpenAPI (`CrudUsersController`).
  Object.defineProperty(cls, 'name', { value: `Crud${pascal(names.plural)}Controller` });

  Controller(path)(cls);
  stampCrudRoutes(cls as unknown as new (...args: never[]) => unknown, config);
  return cls as Type;
}
