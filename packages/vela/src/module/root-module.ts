import { InjectionToken, type Type } from '../container/types';
import type { DynamicModule } from '../registry/types';

/**
 * The module an application was created from, exactly as passed to
 * `VelaFactory.create` or `bootstrap`: a module class or a `DynamicModule`.
 * Global, so any module can read the whole graph (for example to document it
 * with `createOpenApiDocument`) without importing the root back.
 */
export const ROOT_MODULE = new InjectionToken<Type | DynamicModule>('vela.RootModule');
