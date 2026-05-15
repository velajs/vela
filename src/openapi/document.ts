import { METADATA_KEYS, ParamType } from '../constants';
import type { Type } from '../container/types';
import { getCrudBridge } from '../http/crud-bridge';
import { getMetadata } from '../metadata';
import { collectControllers } from '../module/graph';
import { MetadataRegistry } from '../registry/metadata.registry';
import { joinPaths, toOpenApiPath } from '../registry/paths';
import type { ParameterMetadata, RouteDefinition } from '../registry/types';
import { getApiDoc, getApiResponses, getApiTags } from './decorators';
import type {
  CreateOpenApiDocumentOptions,
  HttpVerb,
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
} from './types';
import { isOptional, zodToJsonSchema } from './zod-to-json-schema';

/**
 * Tracks DTO classes referenced during document generation and registers
 * each under `components.schemas`. Handles name collisions by suffixing.
 */
class ComponentsRegistry {
  private schemas = new Map<string, JsonSchema>();
  private classToKey = new WeakMap<object, string>();

  ref(dtoClass: object): { $ref: string } {
    const existing = this.classToKey.get(dtoClass);
    if (existing) return { $ref: `#/components/schemas/${existing}` };

    const baseName =
      (dtoClass as { name?: string }).name && (dtoClass as { name: string }).name !== ''
        ? (dtoClass as { name: string }).name
        : 'Schema';

    let key = baseName;
    let counter = 2;
    while (this.schemas.has(key)) {
      key = `${baseName}${counter++}`;
    }

    this.classToKey.set(dtoClass, key);
    const staticSchema = (dtoClass as { schema?: unknown }).schema;
    this.schemas.set(key, zodToJsonSchema(staticSchema));
    return { $ref: `#/components/schemas/${key}` };
  }

  build(): Record<string, JsonSchema> | undefined {
    if (this.schemas.size === 0) return undefined;
    return Object.fromEntries(this.schemas);
  }
}

function isDtoClass(value: unknown): value is { schema: unknown; name?: string } {
  return typeof value === 'function' && (value as { schema?: unknown }).schema != null;
}

function getParamSchema(
  param: ParameterMetadata,
  paramtypes: unknown[] | undefined,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  const metatype = paramtypes?.[param.index];
  if (!metatype) return undefined;
  if (isDtoClass(metatype)) {
    return registry.ref(metatype) as JsonSchema;
  }
  const maybeSchema = (metatype as { schema?: unknown }).schema;
  if (maybeSchema) {
    return zodToJsonSchema(maybeSchema);
  }
  return undefined;
}

function isParamOptional(param: ParameterMetadata, paramtypes?: unknown[]): boolean {
  const metatype = paramtypes?.[param.index] as { schema?: unknown } | undefined;
  if (metatype?.schema) {
    return isOptional(metatype.schema);
  }
  return true;
}

function isLikelyJsonSchema(value: unknown): value is JsonSchema {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof (v as { toJSONSchema?: unknown }).toJSONSchema === 'function') return false;
  return (
    'type' in v || '$ref' in v || 'oneOf' in v || 'anyOf' in v || 'allOf' in v || 'enum' in v || 'const' in v
  );
}

function resolveResponseSchema(input: unknown, registry: ComponentsRegistry): JsonSchema | undefined {
  if (input === undefined || input === null) return undefined;

  if (isDtoClass(input)) {
    return registry.ref(input) as JsonSchema;
  }

  if (isLikelyJsonSchema(input)) {
    return { ...(input as JsonSchema) };
  }

  if (typeof input === 'object' && typeof (input as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    return zodToJsonSchema(input);
  }

  return undefined;
}

function buildOperation(
  controller: Type,
  route: RouteDefinition,
  pathString: string,
  registry: ComponentsRegistry,
): OpenApiOperation {
  const handlerName = route.handlerName;
  const paramMetadata = MetadataRegistry.getParameters(controller).get(handlerName) ?? [];
  const paramtypes = Reflect.getMetadata('design:paramtypes', controller.prototype, handlerName) as
    | unknown[]
    | undefined;

  const parameters: OpenApiParameter[] = [];
  let requestBody: OpenApiRequestBody | undefined;

  const declaredPathParams = new Set<string>();
  const pathParamNames = [...pathString.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

  for (const param of paramMetadata) {
    if (param.type === ParamType.PARAM && param.name) {
      declaredPathParams.add(param.name);
      parameters.push({
        name: param.name,
        in: 'path',
        required: true,
        schema: getParamSchema(param, paramtypes, registry) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.QUERY && param.name) {
      parameters.push({
        name: param.name,
        in: 'query',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes, registry) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.HEADERS && param.name) {
      parameters.push({
        name: param.name,
        in: 'header',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes, registry) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.BODY) {
      const schema = getParamSchema(param, paramtypes, registry);
      if (schema) {
        requestBody = {
          required: !isParamOptional(param, paramtypes),
          content: { 'application/json': { schema } },
        };
      }
    }
  }

  for (const name of pathParamNames) {
    if (!declaredPathParams.has(name)) {
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }

  const docMeta = getApiDoc(controller, handlerName);
  const controllerTags = getApiTags(controller) ?? [];
  const handlerTags = getApiTags(controller, handlerName) ?? [];
  const docTags = docMeta?.tags ?? [];
  const mergedTags = [...new Set([...controllerTags, ...handlerTags, ...docTags])];

  const responses: Record<string, { description: string; content?: Record<string, { schema: JsonSchema }> }> = {
    '200': { description: 'OK' },
  };

  const apiResponses = getApiResponses(controller, handlerName) ?? [];
  for (const entry of apiResponses) {
    const key = String(entry.status);
    const resolved: { description: string; content?: Record<string, { schema: JsonSchema }> } = {
      description: entry.description,
    };
    const schema = resolveResponseSchema(entry.schema, registry);
    if (schema) {
      resolved.content = { 'application/json': { schema } };
    }
    responses[key] = resolved;
  }

  const operation: OpenApiOperation = { responses };

  if (parameters.length > 0) operation.parameters = parameters;
  if (requestBody) operation.requestBody = requestBody;
  if (docMeta?.summary) operation.summary = docMeta.summary;
  if (docMeta?.description) operation.description = docMeta.description;
  if (docMeta?.operationId) operation.operationId = docMeta.operationId;
  if (docMeta?.deprecated) operation.deprecated = docMeta.deprecated;
  if (mergedTags.length > 0) operation.tags = mergedTags;

  return operation;
}

const VERB_WHITELIST: ReadonlySet<HttpVerb> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);

export function createOpenApiDocument(
  rootModule: Type,
  options: CreateOpenApiDocumentOptions = {},
): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};
  const globalPrefix = options.globalPrefix ?? '';
  const registry = new ComponentsRegistry();

  const controllers = collectControllers(rootModule);

  for (const controller of controllers) {
    const controllerPath = MetadataRegistry.getControllerPath(controller as Type);
    const routes = MetadataRegistry.getRoutes(controller as Type);

    for (const route of routes) {
      const method = route.method.toLowerCase() as HttpVerb;
      if (!VERB_WHITELIST.has(method)) continue;

      const rawPath = joinPaths(joinPaths(globalPrefix, controllerPath), route.path);
      const pathString = toOpenApiPath(rawPath);

      const operation = buildOperation(controller, route, pathString, registry);
      const pathItem = paths[pathString] ?? {};
      pathItem[method] = operation;
      paths[pathString] = pathItem;
    }
  }

  // Second pass: include `@Crud()`-generated routes via the registered
  // CrudBridge. The bridge knows how to turn its own metadata config into
  // OpenAPI path items; this loop is silent when no bridge is registered or
  // no controller carries `vela:crud` metadata, so consumers without
  // `@velajs/crud` see no behavioral change.
  const bridge = getCrudBridge();
  if (bridge) {
    for (const controller of controllers) {
      const crudConfig = getMetadata(METADATA_KEYS.CRUD, controller as Type);
      if (!crudConfig) continue;

      const controllerPrefix = MetadataRegistry.getControllerPath(controller as Type);
      const crudPaths = bridge.buildOpenApiPaths(controller as Type, crudConfig, {
        globalPrefix,
        controllerPrefix,
      });

      for (const [pathKey, pathItem] of Object.entries(crudPaths)) {
        // Verb-level merge: a hand-written `@Get('/')` on the same controller
        // is preserved when the bridge contributes `post`/`patch`/etc. on
        // the same path key.
        paths[pathKey] = { ...(paths[pathKey] ?? {}), ...pathItem };
      }
    }
  }

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: options.info?.title ?? 'Vela API',
      version: options.info?.version ?? '1.0.0',
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    paths,
  };

  const schemas = registry.build();
  if (schemas) {
    document.components = { schemas };
  }

  return document;
}
