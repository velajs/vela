import type { HttpMethod, Scope } from '../constants';
import type { Type } from '../container/types';
import type { PipeType } from '../registry/types';

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string | symbol;
  version?: number | number[];
  /** Route name for URL generation / OpenAPI operationId (`@Get(path, { name })`). */
  name?: string;
}

export interface ControllerOptions {
  path?: string;
  version?: number | number[];
  /**
   * Controller lifetime, like `@Injectable({ scope })`. Defaults to
   * `Scope.SINGLETON`; declaring a different scope elsewhere on the class throws.
   */
  scope?: Scope;
}

export interface ControllerMetadata {
  prefix: string;
  version?: number | number[];
}

export interface ParamMetadata {
  index: number;
  type: string;
  name?: string;
  pipes?: PipeType[];
  factory?: (data: unknown, ctx: import('hono').Context) => unknown;
  /**
   * Explicit param type for programmatic routes. Methods synthesized at
   * runtime (e.g. `@Crud()` verb handlers) have no `design:paramtypes`, so
   * ValidationPipe and the OpenAPI walk read this instead when present.
   */
  metatype?: unknown;
}

export interface ControllerRegistration {
  controller: Type;
  /** Stable container bucket that owns this routed controller instance. */
  moduleId: string;
  metadata: ControllerMetadata;
  routes: RouteMetadata[];
}
