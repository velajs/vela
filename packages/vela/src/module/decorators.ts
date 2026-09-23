import type { CheckedProviders, Provider, ProviderDefinition, Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, DynamicModule, ModuleMetadata, ModuleOptions } from '../registry/types';

export function Global(): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    const existing = MetadataRegistry.getModuleOptions(ctor);
    MetadataRegistry.setModuleOptions(ctor, { ...existing, isGlobal: true });
  };
}

/**
 * `@Module` options. `providers` is checked per element: a
 * `{ provide, useValue | useClass | useExisting | useFactory }` literal must
 * produce its token's value.
 */
export interface ModuleDecoratorOptions<
  P extends readonly unknown[] = readonly Provider[],
> extends Omit<ModuleOptions, 'providers'> {
  providers?: CheckedProviders<P>;
}

// A list the compiler cannot read element by element, such as `flag ? [A] : []`,
// holds classes and definitions. Declared first because TypeScript reports a
// call that no overload accepts against the last overload, which reads each
// element: a literal that names its token must produce its value, while an
// entry typed as the whole `Provider` union, such as the elements of a
// `Provider[]` parameter or of `dynamic.providers ?? []`, spread or not, is
// checked when the module loads.
export function Module(
  options?: ModuleDecoratorOptions<readonly (Type | ProviderDefinition)[]>,
): ClassDecorator;
export function Module<const P extends readonly unknown[] = readonly Provider[]>(
  options?: ModuleDecoratorOptions<P>,
): ClassDecorator;
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
