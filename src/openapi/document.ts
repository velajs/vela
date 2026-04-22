import { getModuleMetadata } from '../module/decorators';
import type { ModuleImport } from '../module/types';
import { ForwardRef } from '../container/types';
import type { Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { ParameterMetadata, RouteDefinition } from '../registry/types';
import { ParamType } from '../constants';
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

interface DynamicModuleLike {
  module: Type;
  imports?: ModuleImport[];
  controllers?: Type[];
}

function isDynamicModuleLike(v: unknown): v is DynamicModuleLike {
  return !!v && typeof v === 'object' && 'module' in v && typeof (v as DynamicModuleLike).module === 'function';
}

function collectControllers(rootModule: Type): Type[] {
  const visited = new Set<Type>();
  const controllers = new Set<Type>();

  function visit(entry: ModuleImport | Type | DynamicModuleLike): void {
    const unwrapped = entry instanceof ForwardRef ? (entry.factory() as Type | DynamicModuleLike) : entry;
    const moduleClass = isDynamicModuleLike(unwrapped) ? unwrapped.module : (unwrapped as Type);
    const extraControllers = isDynamicModuleLike(unwrapped) ? unwrapped.controllers ?? [] : [];
    const extraImports = isDynamicModuleLike(unwrapped) ? unwrapped.imports ?? [] : [];

    if (typeof moduleClass !== 'function' || visited.has(moduleClass)) return;
    visited.add(moduleClass);

    const metadata = getModuleMetadata(moduleClass);
    if (metadata) {
      for (const controller of metadata.controllers) controllers.add(controller);
      for (const imp of metadata.imports) visit(imp as ModuleImport);
    }
    for (const controller of extraControllers) controllers.add(controller);
    for (const imp of extraImports) visit(imp);
  }

  visit(rootModule);
  return [...controllers];
}

function normalizePath(path: string): string {
  // Hono/Nest style `:id` → OpenAPI `{id}`
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

function joinPath(a: string, b: string): string {
  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b && !b.startsWith('/') ? `/${b}` : b;
  const joined = `${left}${right}`;
  return joined || '/';
}

function getParamSchema(param: ParameterMetadata, paramtypes?: unknown[]): JsonSchema | undefined {
  const metatype = paramtypes?.[param.index] as { schema?: unknown } | undefined;
  if (metatype?.schema) {
    return zodToJsonSchema(metatype.schema);
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

function buildOperation(
  controller: Type,
  route: RouteDefinition,
  pathString: string,
): OpenApiOperation {
  const handlerName = route.handlerName;
  const paramMetadata = MetadataRegistry.getParameters(controller).get(handlerName) ?? [];
  const paramtypes = Reflect.getMetadata('design:paramtypes', controller.prototype, handlerName) as
    | unknown[]
    | undefined;

  const parameters: OpenApiParameter[] = [];
  let requestBody: OpenApiRequestBody | undefined;

  // Path params declared in the URL but not listed as @Param() get a string default.
  const declaredPathParams = new Set<string>();
  const pathParamNames = [...pathString.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

  for (const param of paramMetadata) {
    if (param.type === ParamType.PARAM && param.name) {
      declaredPathParams.add(param.name);
      parameters.push({
        name: param.name,
        in: 'path',
        required: true,
        schema: getParamSchema(param, paramtypes) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.QUERY && param.name) {
      parameters.push({
        name: param.name,
        in: 'query',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.HEADERS && param.name) {
      parameters.push({
        name: param.name,
        in: 'header',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.BODY) {
      const schema = getParamSchema(param, paramtypes);
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

  const docMeta = getApiDoc(controller.prototype as object, handlerName);
  const controllerTags = getApiTags(controller) ?? [];
  const handlerTags = getApiTags(controller.prototype as object, handlerName) ?? [];
  const docTags = docMeta?.tags ?? [];

  const mergedTags = [...new Set([...controllerTags, ...handlerTags, ...docTags])];

  const responses: Record<string, { description: string; content?: Record<string, { schema: JsonSchema }> }> = {
    '200': { description: 'OK' },
  };

  const apiResponses = getApiResponses(controller.prototype as object, handlerName) ?? [];
  for (const entry of apiResponses) {
    const key = String(entry.status);
    const resolved: { description: string; content?: Record<string, { schema: JsonSchema }> } = {
      description: entry.description,
    };
    const schema = resolveResponseSchema(entry.schema);
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

function isLikelyJsonSchema(value: unknown): value is JsonSchema {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // Heuristic: JSON Schema has one of these keys AND no toJSONSchema()
  // method (which marks a Zod schema) AND no `schema` static (which
  // marks a DTO class — but DTO classes are functions, not objects).
  if (typeof (v as { toJSONSchema?: unknown }).toJSONSchema === 'function') return false;
  return (
    'type' in v || '$ref' in v || 'oneOf' in v || 'anyOf' in v || 'allOf' in v || 'enum' in v || 'const' in v
  );
}

function resolveResponseSchema(input: unknown): JsonSchema | undefined {
  if (input === undefined || input === null) return undefined;

  // DTO class produced by createZodDto — has a static `schema` property.
  if (typeof input === 'function') {
    const staticSchema = (input as { schema?: unknown }).schema;
    if (staticSchema) return zodToJsonSchema(staticSchema);
    return undefined;
  }

  // Raw JSON Schema object (pass through).
  if (isLikelyJsonSchema(input)) {
    return { ...(input as JsonSchema) };
  }

  // Zod schema (has toJSONSchema() method).
  if (typeof input === 'object' && typeof (input as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    return zodToJsonSchema(input);
  }

  return undefined;
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

  for (const controller of collectControllers(rootModule)) {
    const controllerPath = MetadataRegistry.getControllerPath(controller as Type);
    const routes = MetadataRegistry.getRoutes(controller as Type);

    for (const route of routes) {
      const method = route.method.toLowerCase() as HttpVerb;
      if (!VERB_WHITELIST.has(method)) continue;

      const rawPath = joinPath(joinPath(globalPrefix, controllerPath), route.path);
      const pathString = normalizePath(rawPath);

      const operation = buildOperation(controller, route, pathString);
      const pathItem = paths[pathString] ?? {};
      pathItem[method] = operation;
      paths[pathString] = pathItem;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.info?.title ?? 'Vela API',
      version: options.info?.version ?? '1.0.0',
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    paths,
  };
}
