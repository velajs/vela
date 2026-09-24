import type { CheckedProviders, Provider, ProviderDefinition, Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, ModuleMetadata, ModuleOptions } from '../registry/types';

/**
 * Make a module class global: its exported tokens are visible to every
 * module. Applies in any order relative to `@Module()`. A single instance is
 * made global through `DynamicModule.global` (the `isGlobal` extra of
 * generated `forRoot`/`forRootAsync`).
 */
export function Global(): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    const existing = MetadataRegistry.getModuleOptions(ctor);
    MetadataRegistry.setModuleOptions(ctor, { ...existing, global: true });
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
    const ctor = target as unknown as Constructor;
    // `@Global()` may have run first (decorators apply bottom-up).
    const global = MetadataRegistry.getModuleOptions(ctor)?.global;
    MetadataRegistry.setModuleOptions(ctor, {
      imports: options.imports,
      providers: options.providers,
      controllers: options.controllers,
      exports: options.exports,
      lazy: options.lazy,
      ...(global === true ? { global } : {}),
    });
  };
}

/**
 * Whether a class declares a module itself (`@Module()` or `@Global()`), so a
 * bare import of it names a module. The class of a DynamicModule that
 * declares none is not one, whatever definitions of it loaded before.
 */
export function isModule(target: Constructor): boolean {
  const options = MetadataRegistry.getModuleOptions(target);
  return options !== undefined && options.dynamicHost !== true;
}

export function getModuleMetadata(target: Constructor): ModuleMetadata | undefined {
  const options = MetadataRegistry.getModuleOptions(target);
  if (!options) return undefined;

  return {
    providers: options.providers ?? [],
    controllers: options.controllers ?? [],
    imports: options.imports ?? [],
    exports: options.exports ?? [],
    global: options.global === true,
    lazy: options.lazy === true,
  };
}
