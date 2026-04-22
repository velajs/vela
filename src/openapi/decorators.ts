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
    const existing =
      (Reflect.getMetadata(API_RESPONSES_METADATA, target, propertyKey) as
        | ApiResponseEntry[]
        | undefined) ?? [];
    existing.push({ status, ...options });
    Reflect.defineMetadata(API_RESPONSES_METADATA, existing, target, propertyKey);
  };
}

export function getApiResponses(
  target: object,
  propertyKey: string | symbol,
): ApiResponseEntry[] | undefined {
  return Reflect.getMetadata(API_RESPONSES_METADATA, target, propertyKey) as
    | ApiResponseEntry[]
    | undefined;
}
