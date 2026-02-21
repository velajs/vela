import 'reflect-metadata';
import { METADATA_KEYS } from '@velajs/vela';
import type { CrudConfig } from './types';

export function Crud(config: CrudConfig): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(METADATA_KEYS.CRUD, config, target);
  };
}

export function getCrudConfig(target: object): CrudConfig | undefined {
  return Reflect.getMetadata(METADATA_KEYS.CRUD, target);
}
