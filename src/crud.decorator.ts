import { METADATA_KEYS, defineMetadata, getMetadata } from '@velajs/vela';
import type { CrudConfig } from './types';

export function Crud(config: CrudConfig): ClassDecorator {
  return (target: object) => {
    defineMetadata(METADATA_KEYS.CRUD, config, target);
  };
}

export function getCrudConfig(target: object): CrudConfig | undefined {
  return getMetadata(METADATA_KEYS.CRUD, target) as CrudConfig | undefined;
}
