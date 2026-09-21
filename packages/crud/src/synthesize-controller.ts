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
import { pascalResourceName } from './naming';

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

export function synthesizeController(feature: CrudFeatureResource): Type {
  const names = resourceNames(feature.config);
  const cls = class {};
  Object.defineProperty(cls, 'name', {
    value: `Crud${pascalResourceName(names.plural)}Controller`,
  });
  Controller(feature.path)(cls);
  stampCrudRoutes(cls, feature.config);
  return cls;
}
