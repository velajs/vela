import { METADATA_KEYS, ParamType } from '../constants';
import type { Type } from '../container/types';
import { getRouteContributors } from '../http/route-contributor';
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
  const metatype = param.metatype ?? paramtypes?.[param.index];
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
  const metatype = (param.metatype ?? paramtypes?.[param.index]) as
    | { schema?: unknown }
    | undefined;
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
    'type' in v ||
    '$ref' in v ||
    'oneOf' in v ||
    'anyOf' in v ||
    'allOf' in v ||
    'enum' in v ||
    'const' in v
  );
}

function resolveResponseSchema(
  input: unknown,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  if (input === undefined || input === null) return undefined;

  if (isDtoClass(input)) {
    return registry.ref(input) as JsonSchema;
  }

  if (isLikelyJsonSchema(input)) {
    return { ...(input as JsonSchema) };
  }

  if (
    typeof input === 'object' &&
    typeof (input as { toJSONSchema?: unknown }).toJSONSchema === 'function'
  ) {
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

  const responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  > = {
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
  const operationId = docMeta?.operationId ?? route.name;
  if (operationId) operation.operationId = operationId;
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

  // Second pass: include contributor-generated routes (e.g. `@Crud()` via
  // `@velajs/crud`'s registered RouteContributor). Silent when no contributor
  // is registered or no controller carries claiming metadata, so consumers
  // without contributor packages see no behavioral change.
  for (const contributor of getRouteContributors()) {
    if (!contributor.buildOpenApiPaths) continue;
    for (const controller of controllers) {
      const meta = getMetadata(contributor.claimsMetaKey, controller as Type);
      if (meta === undefined) continue;

      const controllerPrefix = MetadataRegistry.getControllerPath(controller as Type);
      const contributedPaths = contributor.buildOpenApiPaths({
        controller: controller as Type,
        meta,
        globalPrefix,
        controllerPrefix,
      });

      for (const [pathKey, pathItem] of Object.entries(contributedPaths)) {
        // Verb-level merge: a hand-written `@Get('/')` on the same controller
        // is preserved when the contributor adds `post`/`patch`/etc. on the
        // same path key.
        paths[pathKey] = { ...(paths[pathKey] ?? {}), ...pathItem };
      }
    }
  }

  // Aggregate the document-root `tags` array. NestJS declares tag
  // groups/descriptions/order via `DocumentBuilder().addTag(name, desc)`
  // while its scanner auto-collects operation tags; we wire both halves
  // here. Walk every operation's `tags` in first-seen order (stable: paths
  // insertion order, then verb order), then merge with `options.tags`
  // (caller-declared tags first — preserving their order + descriptions —
  // followed by any purely-collected tag not already declared, as `{ name }`).
  const seenTagNames = new Set<string>();
  const collectedTagNames: string[] = [];
  for (const pathItem of Object.values(paths)) {
    for (const verb of VERB_WHITELIST) {
      const operation = pathItem[verb];
      if (!operation?.tags) continue;
      for (const tagName of operation.tags) {
        if (seenTagNames.has(tagName)) continue;
        seenTagNames.add(tagName);
        collectedTagNames.push(tagName);
      }
    }
  }

  const declaredTags = options.tags ?? [];
  const declaredTagNames = new Set(declaredTags.map((t) => t.name));
  const tags: Array<{ name: string; description?: string }> = [
    ...declaredTags,
    ...collectedTagNames.filter((name) => !declaredTagNames.has(name)).map((name) => ({ name })),
  ];

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: options.info?.title ?? 'Vela API',
      version: options.info?.version ?? '1.0.0',
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    // servers sits between info and paths (OpenAPI convention). Omitted when
    // the caller passes none, mirroring the components/tags handling below.
    ...(options.servers?.length ? { servers: options.servers } : {}),
    paths,
  };

  // components.schemas (generated from DTOs) and components.securitySchemes
  // (caller-supplied) share the same `components` object — attach it when
  // either is present so neither clobbers the other.
  const schemas = registry.build();
  if (schemas || options.securitySchemes) {
    document.components = {
      ...(schemas ? { schemas } : {}),
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    };
  }

  // Document-level default security requirements (each operation may override).
  // Omitted entirely when the caller passes none.
  if (options.security?.length) {
    document.security = options.security;
  }

  // Only attach `tags` when non-empty. Emitting `tags: []` on a tag-less
  // spec is the exact symptom the consumer reported, so omit the key
  // entirely in that case (mirrors the `components` handling above).
  if (tags.length > 0) {
    document.tags = tags;
  }

  return document;
}
