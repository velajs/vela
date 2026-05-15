import type { JsonSchema, OpenApiOperation, OpenApiParameter, OpenApiPathItem, Type } from '@velajs/vela';
import { MetadataRegistry } from '@velajs/vela/internal';
import { zodToJsonSchema } from '@velajs/vela';
import type { ZodObject, ZodRawShape } from 'zod';
import { ALL_CRUD_ENDPOINTS, type CrudConfig, type CrudEndpointName } from './types';

interface OpenApiContext {
  globalPrefix: string;
  controllerPrefix: string;
}

// vela's `@ApiTags(...)` decorator stores the tag array under this metadata
// key (see `@velajs/vela`'s openapi/decorators.ts: `API_TAGS_METADATA`). It is
// not re-exported from the public surface, so we read it the same way vela's
// own `getApiTags` does — through the exported `MetadataRegistry`.
const API_TAGS_METADATA = 'vela:openapi:tags';

/**
 * Synchronously contribute OpenAPI path items for a `@Crud()`-decorated
 * controller. Registered on the vela bridge as `buildOpenApiPaths`; vela's
 * `createOpenApiDocument` calls it synchronously while assembling the document,
 * so this MUST NOT be async and MUST NOT touch hono-crud (paths are derived
 * purely from the static `crudConfig`).
 *
 * Path keys are fully qualified (`{globalPrefix}{controllerPrefix}`); vela
 * merges them verb-by-verb into the document, preserving any hand-written
 * `@Get`/`@Post` on the same controller.
 */
export function buildCrudOpenApiPaths(
  controller: Type,
  crudConfig: CrudConfig,
  ctx: OpenApiContext,
): Record<string, OpenApiPathItem> {
  const base = joinOpenApiPaths(ctx.globalPrefix, ctx.controllerPrefix);
  const enabled = new Set<CrudEndpointName>(resolveEnabledEndpoints(crudConfig));
  const tags = resolveTags(controller, crudConfig);

  const modelSchema = getModelSchema(crudConfig);
  const itemSchema = modelSchema ? zodToJsonSchema(modelSchema) : permissiveObject();
  const createBody = schemaFor(crudConfig.dto?.create, modelSchema, itemSchema);
  const updateBody = schemaFor(crudConfig.dto?.update, modelSchema, itemSchema);

  const listResponseSchema = wrapList(itemSchema);
  const itemResponseSchema = wrapItem(itemSchema);
  const deleteAckSchema = wrapDeleteAck();

  const paths: Record<string, OpenApiPathItem> = {};
  const collection: OpenApiPathItem = {};
  const single: OpenApiPathItem = {};

  const idParam: OpenApiParameter = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  };
  const listQuery: OpenApiParameter[] = [
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'order_by', in: 'query', schema: { type: 'string' } },
    { name: 'order_by_direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
    { name: 'search', in: 'query', schema: { type: 'string' } },
  ];

  const withTags = (op: OpenApiOperation): OpenApiOperation =>
    tags.length > 0 ? { ...op, tags } : op;

  if (enabled.has('list')) {
    collection.get = withTags({
      summary: 'List records',
      parameters: listQuery,
      responses: {
        '200': {
          description: 'Paginated list',
          content: { 'application/json': { schema: listResponseSchema } },
        },
      },
    });
  }

  if (enabled.has('create')) {
    collection.post = withTags({
      summary: 'Create a record',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: createBody } },
      },
      responses: {
        '201': {
          description: 'Created record',
          content: { 'application/json': { schema: itemResponseSchema } },
        },
      },
    });
  }

  if (enabled.has('read')) {
    single.get = withTags({
      summary: 'Read a record by id',
      parameters: [idParam],
      responses: {
        '200': {
          description: 'Record',
          content: { 'application/json': { schema: itemResponseSchema } },
        },
        '404': { description: 'Not found' },
      },
    });
  }

  if (enabled.has('update')) {
    single.patch = withTags({
      summary: 'Partially update a record',
      parameters: [idParam],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: updateBody } },
      },
      responses: {
        '200': {
          description: 'Updated record',
          content: { 'application/json': { schema: itemResponseSchema } },
        },
        '404': { description: 'Not found' },
      },
    });
  }

  if (enabled.has('delete')) {
    single.delete = withTags({
      summary: 'Delete a record',
      parameters: [idParam],
      responses: {
        '200': {
          description: 'Deletion ack',
          content: { 'application/json': { schema: deleteAckSchema } },
        },
        '404': { description: 'Not found' },
      },
    });
  }

  if (Object.keys(collection).length > 0) paths[base] = collection;
  if (Object.keys(single).length > 0) paths[`${base}/{id}`] = single;

  return paths;
}

function resolveEnabledEndpoints(config: CrudConfig): CrudEndpointName[] {
  if (config.only) return [...config.only];
  if (config.except) {
    const except = new Set<string>(config.except);
    return ALL_CRUD_ENDPOINTS.filter((e) => !except.has(e));
  }
  return [...ALL_CRUD_ENDPOINTS];
}

function resolveTags(controller: Type, config: CrudConfig): string[] {
  const declared = MetadataRegistry.getCustomClassMeta(controller, API_TAGS_METADATA);
  if (Array.isArray(declared) && declared.length > 0) {
    return declared.filter((t): t is string => typeof t === 'string');
  }
  // Fallback: the model's table name is the most accurate non-decorator
  // label for the resource. Prefer accuracy over an invented tag.
  const table = getTableName(config);
  return table ? [table] : [];
}

function getModelSchema(config: CrudConfig): ZodObject<ZodRawShape> | undefined {
  const model = (config.meta as unknown as { model?: { schema?: unknown } } | undefined)?.model;
  const schema = model?.schema;
  return isZodObject(schema) ? schema : undefined;
}

function getTableName(config: CrudConfig): string | undefined {
  const model = (config.meta as unknown as { model?: { tableName?: unknown } } | undefined)?.model;
  const name = model?.tableName;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function isZodObject(value: unknown): value is ZodObject<ZodRawShape> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { toJSONSchema?: unknown }).toJSONSchema === 'function'
  );
}

function schemaFor(
  dto: ZodObject<ZodRawShape> | undefined,
  modelSchema: ZodObject<ZodRawShape> | undefined,
  itemSchema: JsonSchema,
): JsonSchema {
  if (dto) return zodToJsonSchema(dto);
  if (modelSchema) return zodToJsonSchema(modelSchema);
  return itemSchema;
}

// hono-crud's default response envelope (pre-0.10.0 shape, still the default):
//   list   → { success, result: [...], result_info: {...} }
//   item   → { success, result: {...} }
//   delete → { success, result: { deleted: true } }
function wrapList(itemSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      result: { type: 'array', items: itemSchema },
      result_info: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          per_page: { type: 'integer' },
          total_count: { type: 'integer' },
          total_pages: { type: 'integer' },
          has_next_page: { type: 'boolean' },
          has_prev_page: { type: 'boolean' },
        },
      },
    },
  };
}

function wrapItem(itemSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      result: itemSchema,
    },
  };
}

function wrapDeleteAck(): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      result: {
        type: 'object',
        properties: { deleted: { type: 'boolean' } },
      },
    },
  };
}

function permissiveObject(): JsonSchema {
  return { type: 'object' };
}

// Mirrors `@velajs/vela`'s `joinPaths` + `toOpenApiPath`: collapse the
// boundary slash between prefix and path, guarantee a single leading slash,
// and normalize to an OpenAPI-style path. We only ever join two known,
// already-simple segments here so a focused normalize is sufficient.
function joinOpenApiPaths(globalPrefix: string, controllerPrefix: string): string {
  const clean = (s: string): string => (s ? s.replace(/\/+$/, '') : '');
  const lead = (s: string): string => (s && !s.startsWith('/') ? `/${s}` : s);
  const joined = `${clean(lead(globalPrefix))}${clean(lead(controllerPrefix))}`;
  const normalized = (joined || '/').replace(/\/{2,}/g, '/');
  return normalized.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}
