import type { ApiDocMetadata } from './types';

export const API_DOC_METADATA = 'vela:openapi:doc';
export const API_TAGS_METADATA = 'vela:openapi:tags';

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
      Reflect.defineMetadata(API_DOC_METADATA, metadata, target, propertyKey);
    } else {
      Reflect.defineMetadata(API_DOC_METADATA, metadata, target);
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
      Reflect.defineMetadata(API_TAGS_METADATA, tags, target, propertyKey);
    } else {
      Reflect.defineMetadata(API_TAGS_METADATA, tags, target);
    }
  };
}

export function getApiDoc(target: object, propertyKey?: string | symbol): ApiDocMetadata | undefined {
  return propertyKey !== undefined
    ? (Reflect.getMetadata(API_DOC_METADATA, target, propertyKey) as ApiDocMetadata | undefined)
    : (Reflect.getMetadata(API_DOC_METADATA, target) as ApiDocMetadata | undefined);
}

export function getApiTags(target: object, propertyKey?: string | symbol): string[] | undefined {
  return propertyKey !== undefined
    ? (Reflect.getMetadata(API_TAGS_METADATA, target, propertyKey) as string[] | undefined)
    : (Reflect.getMetadata(API_TAGS_METADATA, target) as string[] | undefined);
}
