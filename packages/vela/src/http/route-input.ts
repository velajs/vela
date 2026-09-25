import type { Context } from 'hono';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '../errors/http-exception';
import type { PipeTransform } from '../pipeline/types';
import {
  isValidationSchema,
  parseSchemaAsync,
  type ValidationSchema,
} from '../validation/parse-schema';
import {
  SchemaValidationError,
  standardJsonSchema,
  staticStandardSchema,
} from '../validation/standard-schema';
import { ValidationPipe } from '../validation/validation.pipe';
import { readBoundedBody, readJsonBody } from './json-body';
import type { ResolvedRouteBody } from './route-contract';
import type { RouteInputReader } from './route-input-registry';
import type { ParamExtractorFactory, ParamMetadata, ParamReader, RouteInputValues } from './types';

// Request values for `@Body()`, `@Query()` and `@Param()`, and the validation
// of the request schemas a route declares. These readers ship with the
// parameter decorators, so an application that declares none of them never
// bundles form parsing or schema introspection.

type JsonObject = Record<string, unknown>;
type FormValue = string | File;
type FormRecord = Record<string, FormValue | FormValue[]>;
type Group = keyof RouteInputValues;

interface FormField {
  readonly multiple: boolean;
  readonly file: boolean;
}

const DECORATOR: Record<Group, string> = { params: 'Param', query: 'Query', body: 'Body' };

// One read per request and key, shared by the route and every parameter
// reading it, so a body stream is consumed once and a schema runs once.
const reads = new WeakMap<Context, Map<object, Promise<unknown>>>();
const BODY = {};

function readOnce<T>(c: Context, key: object, read: () => Promise<T>): Promise<T> {
  let cached = reads.get(c);
  if (!cached) reads.set(c, (cached = new Map()));
  let value = cached.get(key);
  if (!value) cached.set(key, (value = read()));
  return value as Promise<T>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A named parameter reads one member; a value that is not an object is passed whole.
function pick(value: unknown, name: string | undefined): unknown {
  return name !== undefined && value !== null && typeof value === 'object'
    ? Reflect.get(value, name)
    : value;
}

function isValidationPipe(pipe: PipeTransform): boolean {
  return pipe instanceof ValidationPipe;
}

/** The schema a `@Body(schema)`-style parameter validates with. */
function parameterSchema(param: ParamMetadata): ValidationSchema | undefined {
  for (const pipe of param.pipes ?? [])
    if (pipe instanceof ValidationPipe && pipe.parser !== undefined) return pipe.parser;
  return undefined;
}

/** The JSON Schema of a schema that can describe itself; undefined otherwise. */
function describe(
  schema: ValidationSchema | undefined,
  direction: 'input' | 'output' = 'input',
  libraryOptions?: Record<string, unknown>,
): JsonObject | undefined {
  if (!schema) return undefined;
  let json: unknown;
  try {
    json = standardJsonSchema(schema, direction, undefined, libraryOptions);
    if (json === undefined && 'toJSONSchema' in schema && typeof schema.toJSONSchema === 'function')
      json = 'schema' in schema ? schema.toJSONSchema(direction) : schema.toJSONSchema();
    if (json === undefined && 'schema' in schema)
      return describe(schema.schema, direction, libraryOptions);
  } catch {
    return undefined;
  }
  return isObject(json) ? json : undefined;
}

function properties(json: JsonObject | undefined): [string, JsonObject][] {
  return isObject(json?.properties)
    ? Object.entries(json.properties).filter((entry): entry is [string, JsonObject] =>
        isObject(entry[1]),
      )
    : [];
}

// A field JSON Schema cannot express (a coerced date, a custom check) still
// names its key, for converters that take this option.
const KEYS_ONLY = { unrepresentable: 'any' };

/**
 * The keys an object schema accepts (`input`) or returns (`output`), or
 * undefined when it cannot say: it describes no object properties, or passes
 * undeclared keys through.
 */
function declaredKeys(
  schema: ValidationSchema,
  direction: 'input' | 'output',
): Set<string> | undefined {
  const json = describe(schema, direction, KEYS_ONLY);
  if (!isObject(json?.properties) || (json.additionalProperties ?? false) !== false)
    return undefined;
  return new Set(Object.keys(json.properties));
}

async function validate(schema: ValidationSchema, value: unknown): Promise<unknown> {
  try {
    return await parseSchemaAsync(schema, value);
  } catch (error) {
    if (error instanceof SchemaValidationError)
      throw new BadRequestException('Validation failed', {
        details: { issues: error.issues },
        cause: error,
      });
    throw error;
  }
}

// Form fields a schema declares, checked before the route accepts requests: a
// field is text or a file (`format: binary`), or an array of either.
function formFields(
  schema: ValidationSchema | undefined,
  body: ResolvedRouteBody,
  source: string,
): Map<string, FormField> | undefined {
  const json = describe(schema);
  if (!json) return undefined;
  if (json.type !== 'object' || !isObject(json.properties) || json.anyOf || json.oneOf)
    throw new Error(`${source}: a form body schema must be an object with named fields`);
  const fields = new Map<string, FormField>();
  for (const [name, field] of properties(json)) {
    const multiple = field.type === 'array';
    const value = multiple ? field.items : field;
    if (!isObject(value) || value.type !== 'string')
      throw new Error(
        `${source}: form field ${name} must receive strings or files; transform wire strings in its schema`,
      );
    const file = value.format === 'binary';
    if (file && body.kind !== 'multipart')
      throw new Error(`${source}: form file ${name} requires a multipart body`);
    fields.set(name, { multiple, file });
  }
  return fields;
}

// A form body within the route's limits: every entry is measured (413) before
// any field is interpreted.
async function readFormBody(c: Context, body: ResolvedRouteBody): Promise<FormData | undefined> {
  if (c.req.raw.body === null) return undefined;
  const media =
    body.kind === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
  const contentType = c.req.header('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== media)
    throw new UnsupportedMediaTypeException(`Expected ${media} body`);
  const bytes = await readBoundedBody(c, body.maxBytes!);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError)
      throw new BadRequestException('Malformed form body');
    throw error;
  }
  const encoder = new TextEncoder();
  let texts = 0;
  let files = 0;
  for (const [name, value] of form) {
    if (typeof value !== 'string') {
      if (++files > body.maxFiles) throw new PayloadTooLargeException('Form exceeds maxFiles');
      if (value.size > body.maxFileBytes)
        throw new PayloadTooLargeException('Form file exceeds maxFileBytes');
    } else {
      if (++texts > body.maxFields) throw new PayloadTooLargeException('Form exceeds maxFields');
      if (encoder.encode(name).byteLength + encoder.encode(value).byteLength > body.maxFieldBytes)
        throw new PayloadTooLargeException('Form field exceeds maxFieldBytes');
    }
  }
  return form;
}

/**
 * The request body in the encoding a route declares, read once per request
 * after guards: parsed JSON (the default, 415 for other media types), or the
 * `FormData` of a form or multipart route, within its limits (413).
 * `undefined` when the request has no body.
 */
function readRouteBody(c: Context, body: ResolvedRouteBody | undefined): Promise<unknown> {
  return readOnce(c, BODY, () =>
    body && body.kind !== 'json'
      ? readFormBody(c, body)
      : readJsonBody(c, body?.maxBytes === undefined ? {} : { maxBytes: body.maxBytes }),
  );
}

// Named entries of a form body; with declared fields, unknown, repeated and
// mistyped entries answer 400 and a declared array keeps a single entry as an
// array. A JSON body is returned as is.
function formRecord(body: unknown, fields: Map<string, FormField> | undefined): unknown {
  if (!(body instanceof FormData)) return body;
  const result: FormRecord = {};
  for (const [name, value] of body) {
    const file = typeof value !== 'string';
    const field = fields?.get(name);
    if (fields && !field) throw new BadRequestException(`Unknown form field: ${name}`);
    if (field && file !== field.file)
      throw new BadRequestException(`Form field ${name} must be ${field.file ? 'a file' : 'text'}`);
    const previous = Object.hasOwn(result, name) ? result[name] : undefined;
    if (previous === undefined) {
      Object.defineProperty(result, name, {
        value: field?.multiple ? [value] : value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (field && !field.multiple) {
      throw new BadRequestException(`Form field ${name} must not be repeated`);
    } else if (Array.isArray(previous)) {
      previous.push(value);
    } else {
      result[name] = [previous, value];
    }
  }
  return result;
}

// Query keys a schema declares as arrays, in any member of a union.
function arrayKeys(json: JsonObject | undefined): Set<string> {
  const keys = new Set<string>();
  const collect = (node: unknown): void => {
    if (!isObject(node)) return;
    for (const [key, field] of properties(node)) if (field.type === 'array') keys.add(key);
    for (const member of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(node[member])) for (const item of node[member]) collect(item);
  };
  collect(json);
  return keys;
}

function wireQuery(c: Context, arrays: Set<string>): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(c.req.queries())) {
    // A repeated scalar stays an array, so its schema rejects the ambiguity.
    Object.defineProperty(query, name, {
      value: arrays.has(name) || values.length !== 1 ? values : values[0],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return query;
}

// Path parameter names of a served path (`/:id`, `/:id{[0-9]+}`, `/:id?`).
function pathParameters(path: string): string[] {
  return [...path.matchAll(/\/:([^/{}?]+)/g)].map((match) => match[1]!);
}

/**
 * Validates what a route declares — its `params`, `query` and `body` schemas,
 * and its body encoding with its limits — once per request, after guards,
 * before the handler, whether or not a parameter reads them. The application
 * fails to start when a `params` schema that lists the keys it accepts leaves
 * out a path parameter the route serves.
 */
export const readRouteInput: RouteInputReader = (route) => {
  const contract = route.contract!;
  const { params, query, bodySchema } = contract;
  const declared = params && declaredKeys(params, 'input');
  if (declared) {
    const missing = [...new Set(route.paths.flatMap(pathParameters))].filter(
      (name) => !declared.has(name),
    );
    if (missing.length)
      throw new Error(
        `${route.source}: its params schema does not declare the path parameter${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`,
      );
  }
  const arrays = arrayKeys(describe(query));
  const body = contract.body;
  const fields =
    body && body.kind !== 'json' ? formFields(bodySchema, body, route.source) : undefined;
  return (c) =>
    readOnce(c, contract, async () => {
      const values = {
        params: params && (await validate(params, c.req.param())),
        query: query && (await validate(query, wireQuery(c, arrays))),
      };
      const raw = body || bodySchema ? await readRouteBody(c, body) : undefined;
      return {
        ...values,
        body: bodySchema && (await validate(bodySchema, formRecord(raw, fields))),
      };
    });
};

// Whether the request carries a key of a group, before validation.
async function carries(
  c: Context,
  group: Group,
  name: string,
  body: ResolvedRouteBody | undefined,
): Promise<boolean> {
  if (group === 'params') return c.req.param(name) !== undefined;
  if (group === 'query') return c.req.queries(name) !== undefined;
  const raw = await readRouteBody(c, body);
  return raw instanceof FormData ? raw.has(name) : isObject(raw) && Object.hasOwn(raw, name);
}

// Whether a validated value lacks a key: nothing, or an object without it.
function lacks(value: unknown, name: string): boolean {
  return value === null || value === undefined || (typeof value === 'object' && !(name in value));
}

// A parameter reading a group the route declares: the validated value, whole
// or one key, left alone by `ValidationPipe`s. Its own schema would validate
// the value twice, and a key the schema does not return would read nothing:
// the application fails to start when the schema lists the keys it returns,
// and otherwise the request fails (500) when it carries a key the validated
// value lacks. A whole `@Param()` on a params schema that cannot list the keys
// it accepts (which the route checks at startup) fails the request when the
// validated params lack a path parameter the request carries.
function readDeclared(
  route: Parameters<ParamExtractorFactory>[0],
  param: ParamMetadata,
  group: Group,
  schema: ValidationSchema,
): ParamReader {
  const name = param.name;
  const decorator = `@${DECORATOR[group]}(${name === undefined ? '' : `'${name}'`})`;
  if (parameterSchema(param) !== undefined)
    throw new Error(
      `${route.source}: the route declares the ${group} schema; remove the schema from @${DECORATOR[group]}()`,
    );
  const keys = name === undefined ? undefined : declaredKeys(schema, 'output');
  if (name !== undefined && keys && !keys.has(name))
    throw new Error(
      `${route.source}: ${decorator} reads a key the route's ${group} schema does not declare`,
    );
  const unchecked =
    name === undefined && group === 'params' && declaredKeys(schema, 'input') === undefined;
  const input = route.input!;
  const body = route.contract?.body;
  return Object.assign(
    async (c: Context) => {
      const value = (await input(c))[group];
      if (name === undefined) {
        if (unchecked)
          for (const [key, raw] of Object.entries(c.req.param()))
            if (raw !== undefined && lacks(value, key))
              throw new Error(
                `${route.source}: ${decorator} reads params without the path parameter ${key}; the route's params schema does not return it`,
              );
        return value;
      }
      if (lacks(value, name) && (await carries(c, group, name, body)))
        throw new Error(
          `${route.source}: ${decorator} reads a key the route's ${group} schema does not return`,
        );
      return pick(value, name);
    },
    { skips: isValidationPipe },
  );
}

/**
 * `@Body()`: JSON by default (415 for other media types), or the form or
 * multipart body the route opts into, bounded by its limits. A body schema the
 * route declares validates it before the pipes. A parameter class carrying a
 * static Standard Schema, when the parameter names no schema of its own, is
 * validated as the body is read unless a `ValidationPipe` applies to the
 * parameter (its own, or a global, controller or method pipe); then that pipe
 * validates it, in pipe order.
 */
export const readBodyParam: ParamExtractorFactory = (route, param, metatype) => {
  const contract = route.contract;
  if (contract?.bodySchema) return readDeclared(route, param, 'body', contract.bodySchema);
  const body = contract?.body;
  const own = parameterSchema(param);
  const auto = own === undefined ? staticStandardSchema(metatype) : undefined;
  // A whole-body schema declares the form's fields; a named parameter's own
  // schema describes only its member.
  const fields =
    body && body.kind !== 'json'
      ? formFields(param.name === undefined ? (own ?? auto) : undefined, body, route.source)
      : undefined;
  return async (c, pipes) => {
    const value = pick(formRecord(await readRouteBody(c, body), fields), param.name);
    // The class describes the value the parameter receives: the whole body,
    // or the member a named parameter reads.
    return auto && !pipes.some(isValidationPipe) ? validate(auto, value) : value;
  };
};

/**
 * `@Query()`: repeated keys (`?tag=a&tag=b`) and keys the schema declares as
 * arrays (in any member of a union) arrive as arrays; every other key stays a
 * string. The schema is the route's, the parameter's own, or its class's
 * (validated by a global pipe). Without a schema, a named parameter declared
 * as a string, number or boolean receives the first value, one declared as an
 * array with no pipe always receives an array, and any other (an array a pipe
 * such as `ParseArrayPipe` splits, a union, `unknown`) receives one value or
 * the repeated keys.
 */
export const readQueryParam: ParamExtractorFactory = (route, param, metatype) => {
  const group = route.contract?.query;
  if (group) return readDeclared(route, param, 'query', group);
  const schema = parameterSchema(param) ?? (isValidationSchema(metatype) ? metatype : undefined);
  const json = describe(schema);
  const name = param.name;
  if (name === undefined) {
    const arrays = arrayKeys(json);
    return (c) => wireQuery(c, arrays);
  }
  // A named parameter's own schema describes its value.
  const always = json?.type === 'array' || (!schema && metatype === Array && !param.pipes?.length);
  const first = !schema && (metatype === String || metatype === Number || metatype === Boolean);
  return (c) => {
    const values = c.req.queries(name);
    return values && (always || (!first && values.length !== 1)) ? values : values?.[0];
  };
};

/** `@Param()`: path parameters, or the values the route's params schema validated. */
export const readPathParam: ParamExtractorFactory = (route, param) => {
  const group = route.contract?.params;
  if (group) return readDeclared(route, param, 'params', group);
  return (c) => (param.name === undefined ? c.req.param() : c.req.param(param.name));
};
