import { createRouteComposer } from '../http/route-paths';
import { ParamType } from '../constants';
import type { Type } from '../container/types';
import { resolveSuccessStatus } from '../http/response-mapper';
import type { ResolvedRouteBody, RouteContractMetadata } from '../http/route-contract';
import { getRouteContributors } from '../http/route-contributor';
import { getMetadata } from '../metadata';
import { collectControllers } from '../module/graph';
import {
  inheritedParameters,
  inheritedParamTypes,
  inheritedRoutes,
} from '../registry/inherited-metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import { joinPaths, toOpenApiPath } from '../registry/paths';
import type { DynamicModule, ParameterMetadata, RouteDefinition } from '../registry/types';
import { getApiDoc, getApiResponses, getApiTags, isApiExcluded } from './decorators';
import type {
  CreateOpenApiDocumentOptions,
  HttpVerb,
  JsonSchema,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  OpenApiResponse,
} from './types';
import { isOptional, zodToJsonSchema } from './zod-to-json-schema';
import { isRecord } from './json-schema';
import { ValidationPipe } from '../validation/validation.pipe';
import { isStandardSchema } from '../validation/standard-schema';
import { isSchemaParser } from '../validation/dto';

/**
 * Tracks named schema descriptors referenced during document generation and registers
 * each under `components.schemas`. Handles name collisions by suffixing.
 */
class ComponentsRegistry {
  private schemas = new Map<string, JsonSchema>();
  private descriptorToKey = new WeakMap<object, Map<'input' | 'output', string>>();

  ref(
    descriptor: { schema: unknown; name?: string },
    direction: 'input' | 'output' = 'output',
  ): { $ref: string } {
    const keys = this.descriptorToKey.get(descriptor) ?? new Map<'input' | 'output', string>();
    const existing = keys.get(direction);
    if (existing) return { $ref: `#/components/schemas/${existing}` };

    const baseName = descriptor.name || 'Schema';

    let key = baseName;
    let counter = 2;
    while (this.schemas.has(key)) {
      key = `${baseName}${counter++}`;
    }

    const schema =
      'toJSONSchema' in descriptor
        ? zodToJsonSchema(descriptor, direction)
        : zodToJsonSchema(descriptor.schema, direction);
    for (const previous of keys.values())
      if (JSON.stringify(this.schemas.get(previous)) === JSON.stringify(schema)) {
        keys.set(direction, previous);
        return { $ref: `#/components/schemas/${previous}` };
      }
    keys.set(direction, key);
    this.descriptorToKey.set(descriptor, keys);
    this.schemas.set(key, schema);
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

// Request values document a field JSON Schema cannot express (a coerced date,
// a custom check) as any value, for converters that take this option, so the
// fields beside it are still listed.
const REQUEST = { unrepresentable: 'any' };

function describeSchema(
  parser: unknown,
  registry: ComponentsRegistry,
  direction: 'input' | 'output',
): JsonSchema | undefined {
  if (isNamedSchema(parser)) return registry.ref(parser, direction);
  const schema = schemaOf(parser);
  if (isStandardSchema(schema) || (isRecord(schema) && typeof schema.toJSONSchema === 'function'))
    return zodToJsonSchema(schema, direction, direction === 'input' ? REQUEST : undefined);
  return undefined;
}

function getParamSchema(
  param: ParameterMetadata,
  paramtypes: unknown[] | undefined,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  return describeSchema(parameterParser(param, paramtypes), registry, 'input');
}

// Client generation lists query parameters from an object schema's properties.
const UNLISTED_QUERY = 'Query parameters require an object schema.';

function isSchemaOptional(parser: unknown): boolean {
  const schema = schemaOf(parser);
  if (isSchemaParser(schema)) return isOptional(schema);
  return true;
}

function isParamOptional(param: ParameterMetadata, paramtypes?: unknown[]): boolean {
  return isSchemaOptional(parameterParser(param, paramtypes));
}

// `@ApiResponse` documents a schema the application declares with a schema
// library, converted to JSON Schema; raw JSON Schema objects are rejected.
function resolveResponseSchema(
  input: unknown,
  registry: ComponentsRegistry,
): JsonSchema | undefined {
  if (input === undefined || input === null) return undefined;
  const schema = describeSchema(input, registry, 'output');
  if (schema === undefined)
    throw new Error(
      '@ApiResponse schema must be a Standard Schema (such as a Zod or Valibot schema) or a defineDto descriptor',
    );
  return schema;
}

const NATIVE_FORMATS = new Set(['binary', 'stream', 'response']);

function nativeSchema(format: string): JsonSchema {
  return format === 'response' ? {} : { type: 'string', format: 'binary' };
}

// Reason phrases of the success statuses a route can declare.
const SUCCESS_PHRASES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
};

/** The response the route itself declares for its success status. */
function successResponse(
  contract: RouteContractMetadata | undefined,
  status: number,
  registry: ComponentsRegistry,
): OpenApiResponse {
  const response: OpenApiResponse = { description: SUCCESS_PHRASES[status] ?? 'Success' };
  if (!contract || contract.response === null || [204, 205, 304].includes(status)) return response;
  if (contract.format !== undefined && NATIVE_FORMATS.has(contract.format)) {
    const format = contract.format as 'binary' | 'stream' | 'response';
    response['x-vela-response-format'] = format;
    response.content = {
      [contract.contentType ?? 'application/octet-stream']: { schema: nativeSchema(format) },
    };
    return response;
  }
  const schema = contract.response && describeSchema(contract.response, registry, 'output');
  if (contract.format === 'text')
    response.content = { 'text/plain': { schema: schema ?? { type: 'string' } } };
  else if (schema) response.content = { 'application/json': { schema } };
  return response;
}

function bodyLimits(
  body: ResolvedRouteBody,
): NonNullable<OpenApiRequestBody['x-vela-body-limits']> {
  const { kind: _kind, explicitMaxBytes: _explicit, ...limits } = body;
  return body.kind === 'multipart'
    ? limits
    : body.kind === 'form'
      ? {
          maxBytes: limits.maxBytes,
          maxFields: limits.maxFields,
          maxFieldBytes: limits.maxFieldBytes,
        }
      : { maxBytes: limits.maxBytes };
}

/** A request body in the encoding the route accepts. */
function requestBodyFor(
  schema: JsonSchema,
  required: boolean,
  body: ResolvedRouteBody | undefined,
  registry: ComponentsRegistry,
): OpenApiRequestBody {
  if (!body || body.kind === 'json')
    return {
      required,
      content: { 'application/json': { schema } },
      ...(body?.maxBytes !== undefined
        ? { 'x-vela-body-limits': { maxBytes: body.maxBytes } }
        : {}),
    };
  const fields = Object.keys(registry.resolve(schema).properties ?? {});
  return {
    required,
    content: {
      [body.kind === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: {
        schema:
          schema.type === 'object' && !schema.$ref
            ? { ...schema, additionalProperties: false }
            : schema,
        encoding: Object.fromEntries(
          fields.map((name) => [name, { style: 'form', explode: true }]),
        ),
      },
    },
    'x-vela-body-limits': bodyLimits(body),
  };
}

// Declared types an unvalidated named query parameter reads the first value for.
const FIRST_VALUE_TYPES = new Set<unknown>([String, Number, Boolean]);

/** A query parameter; an array is sent as repeated keys (`?tag=a&tag=b`). */
function queryParameter(
  name: string,
  schema: JsonSchema,
  required: boolean,
  registry: ComponentsRegistry,
): OpenApiParameter {
  const resolved = registry.resolve(schema);
  const array = [resolved, ...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])].some(
    (member) => registry.resolve(member).type === 'array',
  );
  return {
    name,
    in: 'query',
    required,
    schema,
    ...(array ? { style: 'form', explode: true } : {}),
  };
}

/** The properties of an object schema, resolving a component reference. */
function objectProperties(
  schema: JsonSchema | undefined,
  registry: ComponentsRegistry,
): { properties: [string, JsonSchema][]; required: string[] } | undefined {
  const resolved = schema && registry.resolve(schema);
  if (resolved?.type !== 'object' || !resolved.properties) return undefined;
  return { properties: Object.entries(resolved.properties), required: resolved.required ?? [] };
}

function buildOperation(
  controller: Type,
  route: RouteDefinition,
  pathString: string,
  registry: ComponentsRegistry,
): OpenApiOperation {
  const handlerName = route.handlerName;
  const contract = route.contract;
  const paramMetadata = inheritedParameters(controller, handlerName).toSorted(
    (a, b) => a.index - b.index,
  );
  const paramtypes = inheritedParamTypes(controller, handlerName);

  const parameters: OpenApiParameter[] = [];
  const clientUnsupported: string[] = [];
  let requestBody: OpenApiRequestBody | undefined;

  const declaredPathParams = new Set<string>();
  const pathParamNames = [...pathString.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const pathParameter = (name: string, schema: JsonSchema = { type: 'string' }): void => {
    declaredPathParams.add(name);
    parameters.push({ name, in: 'path', required: true, schema });
  };

  // A `defineRoute` contract documents its own groups; parameter decorators
  // then read from them.
  for (const param of paramMetadata) {
    if (param.type === ParamType.PARAM && param.name) {
      if (!contract?.params) pathParameter(param.name, getParamSchema(param, paramtypes, registry));
    } else if (param.type === ParamType.QUERY && param.name) {
      if (contract?.query) continue;
      // Without a schema, the declared type decides what the parameter reads:
      // an array with no pipe reads repeated keys, a string, number or boolean
      // the first value, and any other (an array a pipe such as
      // `ParseArrayPipe` splits, a union, `unknown`) one value or the
      // repeated keys.
      const declared = param.metatype ?? paramtypes?.[param.index];
      const many: JsonSchema = { type: 'array', items: { type: 'string' } };
      const wire: JsonSchema =
        declared === Array && !param.pipes?.length
          ? many
          : FIRST_VALUE_TYPES.has(declared)
            ? { type: 'string' }
            : { oneOf: [{ type: 'string' }, many] };
      parameters.push(
        queryParameter(
          param.name,
          getParamSchema(param, paramtypes, registry) ?? wire,
          !isParamOptional(param, paramtypes),
          registry,
        ),
      );
    } else if (param.type === ParamType.QUERY && !param.name) {
      if (contract?.query) continue;
      const object = objectProperties(getParamSchema(param, paramtypes, registry), registry);
      if (object) {
        for (const [name, property] of object.properties)
          parameters.push(queryParameter(name, property, object.required.includes(name), registry));
      } else {
        clientUnsupported.push(UNLISTED_QUERY);
      }
    } else if (param.type === ParamType.HEADERS && param.name) {
      parameters.push({
        name: param.name,
        in: 'header',
        required: !isParamOptional(param, paramtypes),
        schema: getParamSchema(param, paramtypes, registry) ?? { type: 'string' },
      });
    } else if (param.type === ParamType.BODY) {
      if (contract?.bodySchema) continue;
      if (param.name) {
        clientUnsupported.push(
          'Named body parameters require a whole-body DTO for client generation.',
        );
      }
      requestBody = requestBodyFor(
        getParamSchema(param, paramtypes, registry) ?? {},
        !isParamOptional(param, paramtypes),
        contract?.body,
        registry,
      );
    }
  }

  // A group JSON Schema cannot describe as an object (a Valibot schema, a
  // union) is documented as the equivalent decorator options document it: the
  // served path parameters as strings, and the query as unsupported by client
  // generation.
  if (contract?.params) {
    const object = objectProperties(describeSchema(contract.params, registry, 'input'), registry);
    for (const [name, property] of object?.properties ?? []) pathParameter(name, property);
  }
  if (contract?.query) {
    const object = objectProperties(describeSchema(contract.query, registry, 'input'), registry);
    if (!object) clientUnsupported.push(UNLISTED_QUERY);
    else
      for (const [name, property] of object.properties)
        parameters.push(queryParameter(name, property, object.required.includes(name), registry));
  }
  if (contract?.bodySchema) {
    requestBody = requestBodyFor(
      describeSchema(contract.bodySchema, registry, 'input') ?? {},
      !isSchemaOptional(contract.bodySchema),
      contract.body,
      registry,
    );
  }

  for (const name of pathParamNames) {
    if (!declaredPathParams.has(name)) pathParameter(name);
  }

  const docMeta = getApiDoc(controller, handlerName);
  const controllerTags = getApiTags(controller) ?? [];
  const handlerTags = getApiTags(controller, handlerName) ?? [];
  const docTags = docMeta?.tags ?? [];
  const mergedTags = [...new Set([...controllerTags, ...handlerTags, ...docTags])];

  // Document the status and body the runtime sends (see resolveSuccessStatus);
  // `@ApiResponse` adds other statuses, or describes the success one.
  const status = resolveSuccessStatus(controller, route);
  const success = successResponse(contract, status, registry);
  const responses: Record<string, OpenApiResponse> = { [String(status)]: success };
  for (const entry of getApiResponses(controller, handlerName) ?? []) {
    const key = String(entry.status);
    if (key === String(status) && success.content) {
      success.description = entry.description;
      continue;
    }
    const resolved: OpenApiResponse = { description: entry.description };
    const schema = entry.format
      ? nativeSchema(entry.format)
      : resolveResponseSchema(entry.schema, registry);
    if (schema) {
      resolved.content = {
        [entry.contentType ?? (entry.format ? 'application/octet-stream' : 'application/json')]: {
          schema,
        },
      };
    }
    if (entry.format) resolved['x-vela-response-format'] = entry.format;
    responses[key] = resolved;
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
  rootModule: Type | DynamicModule,
  options: CreateOpenApiDocumentOptions = {},
): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};
  const globalPrefix = options.globalPrefix ?? '';
  const registry = new ComponentsRegistry();
  const composeRoutePaths = createRouteComposer(options);

  const controllers = collectControllers(rootModule);

  for (const controller of controllers) {
    if (isApiExcluded(controller)) continue;
    const controllerPath = MetadataRegistry.getControllerPath(controller);
    const controllerVersion = MetadataRegistry.getControllerOptions(controller).version;
    const routes = inheritedRoutes(controller);

    for (const route of routes) {
      const method = HTTP_VERBS.find((verb) => verb === route.method.toLowerCase());
      if (!method || isApiExcluded(controller, route.handlerName)) continue;

      for (const { path: rawPath } of composeRoutePaths(controllerPath, route, controllerVersion)) {
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
      if (meta === undefined || isApiExcluded(controller)) continue;

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
