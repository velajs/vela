import 'reflect-metadata';
import { METADATA_KEYS } from '../constants.js';
import type { CrudConfig } from './types.js';

export function Crud(config: CrudConfig): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(METADATA_KEYS.CRUD, config, target);
  };
}

export function getCrudConfig(target: object): CrudConfig | undefined {
  return Reflect.getMetadata(METADATA_KEYS.CRUD, target);
}
