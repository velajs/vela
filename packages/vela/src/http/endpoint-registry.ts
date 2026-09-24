import type { Context } from 'hono';
import type { RuntimeEndpointDefinition } from '../openapi/endpoint';
import type { PipeTransform } from '../pipeline/types';

/**
 * How the route pipeline runs one `@Endpoint` handler. `@Endpoint` supplies
 * the input extraction and response mapping with the definition, so the
 * schema parsing and body readers they need ship only with applications that
 * use `@Endpoint`.
 */
export interface EndpointBinding {
  readonly definition: RuntimeEndpointDefinition;
  /** Extract, pipe and parse the handler's single input argument. */
  extractInput(context: Context, pipes: readonly PipeTransform[]): Promise<unknown[]>;
  /** Parse the final interceptor result and build the response. */
  mapResponse(context: Context, result: unknown): Promise<Response>;
}

const bindings = new WeakMap<object, Map<string | symbol, EndpointBinding>>();

/** Record the endpoint a controller method (on `prototype`) serves. */
export function setEndpointBinding(
  prototype: object,
  key: string | symbol,
  binding: EndpointBinding,
): void {
  let methods = bindings.get(prototype);
  if (!methods) {
    methods = new Map();
    bindings.set(prototype, methods);
  }
  methods.set(key, binding);
}

/** The endpoint a controller method serves, inherited through its prototype chain. */
export function getEndpointBinding(
  controller: object,
  key: string | symbol,
): EndpointBinding | undefined {
  let current: unknown = typeof controller === 'function' ? controller.prototype : controller;
  while (current !== null && typeof current === 'object') {
    const binding = bindings.get(current)?.get(key);
    if (binding) return binding;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
