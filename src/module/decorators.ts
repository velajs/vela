import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, ModuleMetadata, ModuleOptions, Type } from '../registry/types';

export function Global(): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    const existing = MetadataRegistry.getModuleOptions(ctor);
    MetadataRegistry.setModuleOptions(ctor, { ...existing, isGlobal: true });
  };
}

export function Module(options: ModuleOptions = {}): ClassDecorator {
  return (target) => {
    MetadataRegistry.setModuleOptions(target as unknown as Constructor, {
      imports: options.imports,
      providers: options.providers,
      controllers: options.controllers,
      exports: options.exports,
      isGlobal: options.isGlobal,
    });
  };
}

export function isModule(target: Constructor): boolean {
  return MetadataRegistry.getModuleOptions(target) !== undefined;
}

export function createModuleRef(name: string): Type {
  const moduleClass = class {} as unknown as Type;
  Object.defineProperty(moduleClass, 'name', { value: name });
  return moduleClass;
}

export function getModuleMetadata(target: Constructor): ModuleMetadata | undefined {
  const options = MetadataRegistry.getModuleOptions(target);
  if (!options) return undefined;

  return {
    providers: options.providers ?? [],
    controllers: options.controllers ?? [],
    imports: options.imports ?? [],
    exports: options.exports ?? [],
    isGlobal: options.isGlobal === true,
  };
}
