/** Headless features compile each schema before entering a heterogeneous module list. */
import { Controller, type Type } from '@velajs/vela';
import type { ZodRawShape } from 'zod';
import {
  compileCrudConfig,
  resourceNames,
  type CrudConfig,
  type RuntimeCrudConfig,
} from './crud.types';
import { stampCrudRoutes } from './stamp-routes';

export interface CrudFeatureResource {
  path: string;
  config: RuntimeCrudConfig;
}

export function defineCrudFeature<Shape extends ZodRawShape>(
  feature: CrudConfig<Shape> & { path: string },
): CrudFeatureResource {
  const { path, ...config } = feature;
  return { path, config: compileCrudConfig(config) };
}

const pascal = (s: string): string =>
  s.replace(/(?:^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());

export function synthesizeController(feature: CrudFeatureResource): Type {
  const names = resourceNames(feature.config);
  const cls = class {};
  Object.defineProperty(cls, 'name', { value: `Crud${pascal(names.plural)}Controller` });
  Controller(feature.path)(cls);
  stampCrudRoutes(cls, feature.config);
  return cls;
}
