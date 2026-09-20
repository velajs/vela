import { ParamType } from '../constants';
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
import { isRecord, parseJsonSchema } from './json-schema';
import { getEndpointDefinition } from './endpoint';
import { ValidationPipe } from '../validation/validation.pipe';
import { isSchemaParser } from '../validation/dto';

/**
 * Tracks named schema descriptors referenced during document generation and registers
 * each under `components.schemas`. Handles name collisions by suffixing.
 */
class ComponentsRegistry {
  private schemas = new Map<string, JsonSchema>();
  private descriptorToKey = new WeakMap<object, string>();

  ref(descriptor: { schema: unknown; name?: string }): { $ref: string } {
    const existing = this.descriptorToKey.get(descriptor);
    if (existing) return { $ref: `#/components/schemas/${existing}` };

    const baseName = descriptor.name || 'Schema';

    let key = baseName;
    let counter = 2;
    while (this.schemas.has(key)) {
      key = `${baseName}${counter++}`;
    }

    this.descriptorToKey.set(descriptor, key);
    this.schemas.set(key, zodToJsonSchema(descriptor.schema));
    return { $ref: `#/components/schemas/${key}` };
  }

  build(): Record<string, JsonSchema> | undefined {
    if (this.schemas.size === 0) return undefined;
    return Object.fromEntries(this.schemas);
  }

  resolve(schema: JsonSchema): JsonSchema {
    const prefix = '#/components/schemas/';
    return schema.$ref?.startsWith(prefix)
      ? (this.schemas.get(schema.$ref.slice(prefix.length)) ?? schema)
      : schema;
  }
}

function isNamedSchema(value: unknown): value is { schema: unknown; name: string } {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'schema' in value &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

function schemaOf(value: unknown): unknown {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    'schema' in value
    ? value.schema
    : value;
}

function parameterParser(param: ParameterMetadata, paramtypes?: unknown[]): unknown {
  const explicit = param.pipes?.find(
    (pipe) => pipe instanceof ValidationPipe && pipe.parser !== undefined,
  );
  return explicit instanceof ValidationPipe
    ? explicit.parser
    : (param.metatype ?? paramtypes?.[param.index]);
}

function getParamSchema(
  param: ParameterMetadata,
  paramtypes: unknown[] | undefined,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  const parser = parameterParser(param, paramtypes);
  if (isNamedSchema(parser)) return registry.ref(parser);
  const schema = schemaOf(parser);
  if (isRecord(schema) && typeof schema.toJSONSchema === 'function') return zodToJsonSchema(schema);
  return undefined;
}

function isParamOptional(param: ParameterMetadata, paramtypes?: unknown[]): boolean {
  const schema = schemaOf(parameterParser(param, paramtypes));
  if (isSchemaParser(schema)) return isOptional(schema);
  return true;
}

function resolveResponseSchema(
  input: unknown,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  if (input === undefined || input === null) return undefined;

  if (isNamedSchema(input)) {
    return registry.ref(input);
  }
  if (isRecord(input) && typeof input.toJSONSchema === 'function') {
    return zodToJsonSchema(input);
  }
  return parseJsonSchema(input, '@ApiResponse schema');
}

function buildOperation(
  controller: Type,
  route: RouteDefinition,
  pathString: string,
  registry: ComponentsRegistry,
): OpenApiOperation {
  const handlerName = route.handlerName;
  const endpoint = getEndpointDefinition(controller, handlerName);
  const paramMetadata = MetadataRegistry.getParameters(controller).get(handlerName) ?? [];
  const reflectedParams: unknown = Reflect.getMetadata(
    'design:paramtypes',
    controller.prototype,
    handlerName,
  );
  const paramtypes: unknown[] | undefined = Array.isArray(reflectedParams)
    ? reflectedParams
    : undefined;

  const parameters: OpenApiParameter[] = [];
  const clientUnsupported: string[] = [];
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
    } else if (param.type === ParamType.QUERY && !param.name) {
      const schema = getParamSchema(param, paramtypes, registry);
      const resolved = schema && registry.resolve(schema);
      if (resolved?.type === 'object' && resolved.properties) {
        for (const [name, property] of Object.entries(resolved.properties)) {
          parameters.push({
            name,
            in: 'query',
            required: resolved.required?.includes(name) ?? false,
            schema: property,
          });
        }
      } else {
        clientUnsupported.push('Whole-query parameters require an object DTO schema.');
      }
    } else if (param.type === ParamType.HEADERS && param.name) {
      parameters.push({
        name: param.name,
        in: 'header',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes, registry) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.BODY) {
      const schema = getParamSchema(param, paramtypes, registry) ?? {};
      if (param.name) {
        clientUnsupported.push(
          'Named body parameters require a whole-body DTO for client generation.',
        );
      }
      requestBody = {
        required: !isParamOptional(param, paramtypes),
        content: { 'application/json': { schema } },
      };
    }
  }

  for (const name of pathParamNames) {
    if (!declaredPathParams.has(name)) {
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }

  if (endpoint) {
    if (paramMetadata.length)
      throw new Error(
        '@Endpoint methods receive one schema-parsed input; remove parameter decorators from this method.',
      );
    parameters.length = 0;
    requestBody = undefined;
    const groups = endpoint.inputSchema.properties ?? {};
    const requiredGroups = new Set(endpoint.inputSchema.required ?? []);
    for (const group of Object.keys(groups)) {
      if (!['param', 'query', 'header', 'json'].includes(group))
        throw new Error(`Unsupported endpoint input group: ${group}`);
    }
    for (const [group, location] of [
      ['param', 'path'],
      ['query', 'query'],
      ['header', 'header'],
    ] as const) {
      const schema = groups[group];
      if (!schema) continue;
      if (schema.type !== 'object' || !schema.properties)
        throw new Error(`Endpoint ${group} must export an object schema with properties.`);
      for (const [name, property] of Object.entries(schema.properties)) {
        parameters.push({
          name,
          in: location,
          required:
            location === 'path' ||
            (requiredGroups.has(group) && (schema.required?.includes(name) ?? false)),
          schema: property,
        });
      }
    }
    for (const name of pathParamNames) {
      if (!parameters.some((parameter) => parameter.in === 'path' && parameter.name === name))
        parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
    if (groups.json)
      requestBody = {
        required: requiredGroups.has('json'),
        content: { 'application/json': { schema: groups.json } },
      };
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
    [String(
      endpoint?.status ??
        MetadataRegistry.getHandlerHttpMeta(controller, handlerName)?.httpCode ??
        200,
    )]: {
      description: 'OK',
    },
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
  if (endpoint) {
    responses[String(endpoint.status)] = {
      description: 'Success',
      content: {
        [endpoint.format === 'text' ? 'text/plain' : 'application/json']: {
          schema: endpoint.outputSchema,
        },
      },
    };
  }

  const operation: OpenApiOperation = { responses };
  if (clientUnsupported.length > 0) {
    Object.assign(operation, { 'x-vela-client-unsupported': clientUnsupported });
  }

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

const HTTP_VERBS: HttpVerb[] = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

export function createOpenApiDocument(
  rootModule: Type,
  options: CreateOpenApiDocumentOptions = {},
): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};
  const globalPrefix = options.globalPrefix ?? '';
  const registry = new ComponentsRegistry();

  const controllers = collectControllers(rootModule);

  for (const controller of controllers) {
    const controllerPath = MetadataRegistry.getControllerPath(controller);
    const controllerVersion = MetadataRegistry.getControllerOptions(controller).version;
    const routes = MetadataRegistry.getRoutes(controller);

    for (const route of routes) {
      const method = HTTP_VERBS.find((verb) => verb === route.method.toLowerCase());
      if (!method) continue;

      const version = route.version ?? controllerVersion;
      const versions =
        version === undefined ? [undefined] : Array.isArray(version) ? version : [version];
      for (const entry of versions) {
        const prefix = entry === undefined ? globalPrefix : joinPaths(globalPrefix, `/v${entry}`);
        const rawPath = joinPaths(joinPaths(prefix, controllerPath), route.path);
        const pathString = toOpenApiPath(rawPath);

        const operation = buildOperation(controller, route, pathString, registry);
        const pathItem = paths[pathString] ?? {};
        pathItem[method] = operation;
        paths[pathString] = pathItem;
      }
    }
  }

  // Second pass: include contributor-generated routes (e.g. `@Crud()` via
  // `@velajs/crud`'s registered RouteContributor). Silent when no contributor
  // is registered or no controller carries claiming metadata, so consumers
  // without contributor packages see no behavioral change.
  for (const contributor of getRouteContributors()) {
    if (!contributor.buildOpenApiPaths) continue;
    for (const controller of controllers) {
      const meta = getMetadata(contributor.claimsMetaKey, controller);
      if (meta === undefined) continue;

      const controllerPrefix = MetadataRegistry.getControllerPath(controller);
      const contributedPaths = contributor.buildOpenApiPaths({
        controller,
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
    for (const verb of HTTP_VERBS) {
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
