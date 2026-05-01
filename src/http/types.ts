import type { HttpMethod } from '../constants';
import type { Type } from '../container/types';
import type { PipeType } from '../registry/types';

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string | symbol;
  version?: number | number[];
}

export interface ControllerOptions {
  path?: string;
  version?: number | number[];
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
}

export interface ControllerRegistration {
  controller: Type;
  metadata: ControllerMetadata;
  routes: RouteMetadata[];
}
