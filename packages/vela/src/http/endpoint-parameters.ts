import { CUSTOM_PARAM_TYPE, ParamType } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, ParameterMetadata } from '../registry/types';

// Built-in readers of request data that an endpoint input owns. The input
// schema validates and documents that data; a second reader would bypass both.
const INPUT_READERS: ReadonlyMap<string, readonly [decorator: string, remedy: string]> = new Map([
  [ParamType.PARAM, ['@Param()', 'declare the value in the input param group']],
  [ParamType.QUERY, ['@Query()', 'declare the value in the input query group']],
  [ParamType.HEADERS, ['@Headers()', 'declare the value in the input header group']],
  [ParamType.BODY, ['@Body()', 'declare the value in the input json or form group']],
  [ParamType.RAW_BODY, ['@RawBody()', 'read raw bytes on a route without @Endpoint']],
]);

// Request context rather than contract input: custom and lazy decorators, the
// Hono context, the runtime-attested client address, and cookies.
const CONTEXT_TYPES: ReadonlySet<string> = new Set([
  CUSTOM_PARAM_TYPE,
  ParamType.REQUEST,
  ParamType.RESPONSE,
  ParamType.IP,
  ParamType.COOKIE,
]);

/**
 * Enforce the `@Endpoint` method contract shared by route building and OpenAPI
 * generation. The endpoint owns the response status, and parameter 0 receives
 * the validated input. Later parameters may use context decorators, which are
 * not part of the HTTP contract; decorators that read the input's own request
 * data are rejected.
 */
export function assertEndpointMethod(
  controller: Constructor,
  handlerName: string | symbol,
  parameters: readonly Pick<ParameterMetadata, 'index' | 'type'>[],
): void {
  const owner = `${controller.name}.${String(handlerName)}`;
  const response = MetadataRegistry.getHandlerHttpMeta(controller, handlerName);
  if (response?.redirect || response?.httpCode !== undefined) {
    throw new Error(`${owner}: @Endpoint owns the response status; remove @HttpCode and @Redirect`);
  }
  for (const { index, type } of parameters) {
    if (index === 0) {
      throw new Error(
        `${owner}: @Endpoint passes its validated input as parameter 0; remove the parameter decorator from it`,
      );
    }
    const reader = INPUT_READERS.get(type);
    if (reader) {
      throw new Error(
        `${owner}: parameter ${index} uses ${reader[0]}, which reads request data the @Endpoint input owns; ${reader[1]}`,
      );
    }
    if (!CONTEXT_TYPES.has(type)) {
      throw new Error(
        `${owner}: parameter ${index} uses unsupported parameter type '${type}'; @Endpoint context parameters accept createParamDecorator decorators, @Req(), @Res(), @Ip(), and @Cookie()`,
      );
    }
  }
}
