import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, DynamicModule, ModuleMetadata, ModuleOptions } from '../registry/types';

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
      lazy: options.lazy,
    });
  };
}

export function isModule(target: Constructor): boolean {
  return MetadataRegistry.getModuleOptions(target) !== undefined;
}

/**
 * Normalize a DynamicModule, defaulting `key` to `"default"`. Module authors
 * call this from `forRoot()` so the loader always sees an explicit key.
 */
export function defineDynamicModule(input: DynamicModule): DynamicModule {
  return { ...input, key: input.key ?? 'default' };
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
    lazy: options.lazy === true,
  };
}
