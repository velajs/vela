import type { Context } from 'hono';
import type { HttpMethod, Scope } from '../constants';
import type { Type } from '../container/types';
import type { PipeType } from '../registry/types';
import type { RouteContractMetadata } from './route-contract';
import type { VersionValue } from './version';

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string | symbol;
  version?: VersionValue;
  /** Route name for URL generation / OpenAPI operationId (`@Get(path, { name })`). */
  name?: string;
  /** What the route declares through its decorator options or `defineRoute` contract. */
  contract?: RouteContractMetadata;
}

/** The route a parameter reader is built for, once, when the application starts. */
export interface ParamExtractionRoute {
  readonly method: string;
  readonly contract?: RouteContractMetadata;
  /** `Controller.handler`, for configuration errors. */
  readonly source: string;
}

/**
 * Builds a parameter's request reader for one route. Built-in `@Body`,
 * `@Query` and `@Param` supply one; it runs after guards, before pipes.
 */
export type ParamExtractorFactory = (
  route: ParamExtractionRoute,
  param: ParamMetadata,
  metatype: unknown,
) => (c: Context) => unknown;

export interface ControllerOptions {
  path?: string;
  version?: VersionValue;
  /**
   * Controller lifetime, like `@Injectable({ scope })`. Defaults to
   * `Scope.DEFAULT`; declaring a different scope elsewhere on the class throws.
   */
  scope?: Scope;
}

export interface ControllerMetadata {
  prefix: string;
  version?: VersionValue;
}

export interface ParamMetadata {
  index: number;
  type: string;
  name?: string;
  pipes?: PipeType[];
  factory?: (data: unknown, ctx: Context) => unknown;
  /** The route-aware request reader `@Body`, `@Query` and `@Param` record. */
  extract?: ParamExtractorFactory;
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
