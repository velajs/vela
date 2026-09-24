import { endpointContentType } from './endpoint-response';
import { MetadataRegistry } from '../registry/metadata.registry';
import { isRecord } from './json-schema';
import type { ApiDocMetadata, ApiResponseEntry, ApiResponseOptions } from './types';

export const API_DOC_METADATA = 'vela:openapi:doc';
export const API_TAGS_METADATA = 'vela:openapi:tags';
export const API_RESPONSES_METADATA = 'vela:openapi:responses';
export const API_EXCLUDE_METADATA = 'vela:openapi:exclude';

/**
 * Leave a controller, or one handler, out of the OpenAPI document (and the
 * generated client). The routes are still served.
 *
 * ```ts
 * @ApiExclude()
 * @Controller('/internal')
 * class InternalController {}
 * ```
 */
export function ApiExclude(): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      MetadataRegistry.setCustomHandlerMeta(
        target.constructor,
        propertyKey,
        API_EXCLUDE_METADATA,
        true,
      );
    } else {
      MetadataRegistry.setCustomClassMeta(target, API_EXCLUDE_METADATA, true);
    }
  };
}

/**
 * Whether `@ApiExclude()` leaves this controller out of the document, or,
 * with a handler name, this handler (directly or through its controller).
 */
export function isApiExcluded(target: object, propertyKey?: string | symbol): boolean {
  if (MetadataRegistry.getCustomClassMeta(target, API_EXCLUDE_METADATA) === true) return true;
  return (
    propertyKey !== undefined &&
    MetadataRegistry.getCustomHandlerMeta(target, propertyKey, API_EXCLUDE_METADATA) === true
  );
}

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
      MetadataRegistry.setCustomHandlerMeta(
        target.constructor,
        propertyKey,
        API_DOC_METADATA,
        metadata,
      );
    } else {
      MetadataRegistry.setCustomClassMeta(target, API_DOC_METADATA, metadata);
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
      MetadataRegistry.setCustomHandlerMeta(
        target.constructor,
        propertyKey,
        API_TAGS_METADATA,
        tags,
      );
    } else {
      MetadataRegistry.setCustomClassMeta(target, API_TAGS_METADATA, tags);
    }
  };
}

export function getApiDoc(
  target: object,
  propertyKey?: string | symbol,
): ApiDocMetadata | undefined {
  const value =
    propertyKey === undefined
      ? MetadataRegistry.getCustomClassMeta(target, API_DOC_METADATA)
      : MetadataRegistry.getCustomHandlerMeta(target, propertyKey, API_DOC_METADATA);
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid OpenAPI documentation metadata');
  const metadata: ApiDocMetadata = {};
  for (const key of ['summary', 'description', 'operationId'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string') throw new Error(`Invalid OpenAPI ${key}`);
    metadata[key] = value[key];
  }
  if (value.deprecated !== undefined) {
    if (typeof value.deprecated !== 'boolean') throw new Error('Invalid OpenAPI deprecated');
    metadata.deprecated = value.deprecated;
  }
  if (value.tags !== undefined) metadata.tags = parseTags(value.tags);
  return metadata;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid OpenAPI tags');
  return value.map((tag: unknown) => {
    if (typeof tag !== 'string') throw new Error('Invalid OpenAPI tag');
    return tag;
  });
}

export function getApiTags(target: object, propertyKey?: string | symbol): string[] | undefined {
  const value =
    propertyKey === undefined
      ? MetadataRegistry.getCustomClassMeta(target, API_TAGS_METADATA)
      : MetadataRegistry.getCustomHandlerMeta(target, propertyKey, API_TAGS_METADATA);
  return value === undefined ? undefined : parseTags(value);
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
export function ApiResponse(status: number | string, options: ApiResponseOptions): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const responses = getApiResponses(target.constructor, propertyKey) ?? [];
    MetadataRegistry.setCustomHandlerMeta(target.constructor, propertyKey, API_RESPONSES_METADATA, [
      ...responses,
      { status, ...options },
    ]);
  };
}

export function getApiResponses(
  target: object,
  propertyKey: string | symbol,
): ApiResponseEntry[] | undefined {
  const value = MetadataRegistry.getCustomHandlerMeta(target, propertyKey, API_RESPONSES_METADATA);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid OpenAPI responses');
  return value.map((entry: unknown): ApiResponseEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.description !== 'string' ||
      (typeof entry.status !== 'string' && typeof entry.status !== 'number')
    )
      throw new Error('Invalid OpenAPI response');
    if (entry.contentType !== undefined && typeof entry.contentType !== 'string')
      throw new Error('Invalid OpenAPI response contentType');
    if (
      entry.format !== undefined &&
      entry.format !== 'binary' &&
      entry.format !== 'stream' &&
      entry.format !== 'response'
    )
      throw new Error('Invalid OpenAPI response format');
    if (entry.format !== undefined && entry.schema !== undefined)
      throw new Error('Native OpenAPI responses cannot declare a JSON schema');
    return {
      ...(entry.contentType === undefined
        ? {}
        : { contentType: endpointContentType(entry.contentType) }),
      ...(entry.format === undefined ? {} : { format: entry.format }),
      status: entry.status,
      description: entry.description,
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
    };
  });
}
