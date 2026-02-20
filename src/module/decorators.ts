import 'reflect-metadata';
import { METADATA_KEYS } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { ModuleMetadata, ModuleOptions } from './types';

export function Module(options: ModuleOptions = {}): ClassDecorator {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return (target: Function) => {
    Reflect.defineMetadata(METADATA_KEYS.MODULE, true, target);

    MetadataRegistry.setModuleOptions(target, {
      imports: options.imports,
      providers: options.providers,
      controllers: options.controllers,
      exports: options.exports,
    });
  };
}

export function isModule(target: Constructor): boolean {
  return Reflect.getMetadata(METADATA_KEYS.MODULE, target) === true;
}

export function getModuleMetadata(target: Constructor): ModuleMetadata | undefined {
  if (!isModule(target)) {
    return undefined;
  }

  const options = MetadataRegistry.getModuleOptions(target);
  if (!options) {
    return undefined;
  }

  return {
    providers: (options.providers ?? []) as ModuleMetadata['providers'],
    controllers: (options.controllers ?? []) as ModuleMetadata['controllers'],
    imports: (options.imports ?? []) as ModuleMetadata['imports'],
    exports: (options.exports ?? []) as ModuleMetadata['exports'],
  };
}
