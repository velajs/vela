import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { ApiDocMetadata, ApiResponseEntry, ApiResponseOptions } from './types';

export const API_DOC_METADATA = 'vela:openapi:doc';
export const API_TAGS_METADATA = 'vela:openapi:tags';
export const API_RESPONSES_METADATA = 'vela:openapi:responses';

/**
 * Attach OpenAPI documentation to a route handler (or controller).
 *
 * ```ts
 * @Get('/:id')
 * @ApiDoc({ summary: 'Get a user', description: '...', operationId: 'getUser' })
 * findOne(@Param('id') id: string) { ... }
 * ```
 */
export function ApiDoc(metadata: ApiDocMetadata): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      MetadataRegistry.setCustomHandlerMeta(target.constructor as Constructor, propertyKey, API_DOC_METADATA, metadata);
    } else {
      MetadataRegistry.setCustomClassMeta(target as Constructor, API_DOC_METADATA, metadata);
    }
  };
}

/**
 * Attach OpenAPI tags to a controller or handler. Handler-level tags merge
 * with controller-level tags; duplicates are de-duplicated in the output.
 */
export function ApiTags(...tags: string[]): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      MetadataRegistry.setCustomHandlerMeta(target.constructor as Constructor, propertyKey, API_TAGS_METADATA, tags);
    } else {
      MetadataRegistry.setCustomClassMeta(target as Constructor, API_TAGS_METADATA, tags);
    }
  };
}

export function getApiDoc(target: object, propertyKey?: string | symbol): ApiDocMetadata | undefined {
  if (propertyKey !== undefined) {
    return MetadataRegistry.getCustomHandlerMeta(target as Constructor, propertyKey, API_DOC_METADATA) as
      | ApiDocMetadata
      | undefined;
  }
  return MetadataRegistry.getCustomClassMeta(target as Constructor, API_DOC_METADATA) as
    | ApiDocMetadata
    | undefined;
}

export function getApiTags(target: object, propertyKey?: string | symbol): string[] | undefined {
  if (propertyKey !== undefined) {
    return MetadataRegistry.getCustomHandlerMeta(target as Constructor, propertyKey, API_TAGS_METADATA) as
      | string[]
      | undefined;
  }
  return MetadataRegistry.getCustomClassMeta(target as Constructor, API_TAGS_METADATA) as
    | string[]
    | undefined;
}

/**
 * Document a response for a given status code. Stackable: apply multiple
 * times on the same handler to declare different statuses.
 *
 * ```ts
 * @Get('/:id')
 * @ApiResponse(200, { description: 'Found', schema: UserDto })
 * @ApiResponse(404, { description: 'Not found', schema: ErrorDto })
 * findOne() { ... }
 * ```
 */
export function ApiResponse(
  status: number | string,
  options: ApiResponseOptions,
): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomHandlerMeta<ApiResponseEntry>(
      target.constructor as Constructor,
      propertyKey,
      API_RESPONSES_METADATA,
      { status, ...options },
    );
  };
}

export function getApiResponses(
  target: object,
  propertyKey: string | symbol,
): ApiResponseEntry[] | undefined {
  return MetadataRegistry.getCustomHandlerMeta(
    target as Constructor,
    propertyKey,
    API_RESPONSES_METADATA,
  ) as ApiResponseEntry[] | undefined;
}
