import type { Context } from 'hono';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '../errors/http-exception';
import { parseSchemaAsync, type ValidationSchema } from '../validation/parse-schema';
import {
  SchemaValidationError,
  standardJsonSchema,
  staticStandardSchema,
} from '../validation/standard-schema';
import { ValidationPipe } from '../validation/validation.pipe';
import { readBoundedBody, readJsonBody } from './json-body';
import type { ResolvedRouteBody } from './route-contract';
import type { ParamExtractorFactory, ParamMetadata } from './types';

// Request values for `@Body()`, `@Query()` and `@Param()`. These readers ship
// with the parameter decorators, so an application that declares none of
// them never bundles form parsing or schema introspection.

type JsonObject = Record<string, unknown>;
type FormValue = string | File;
type FormRecord = Record<string, FormValue | FormValue[]>;

interface FormField {
  readonly multiple: boolean;
  readonly file: boolean;
}

// One read per request and value source, shared by every parameter reading it,
// so a transforming schema runs once and a body stream is consumed once.
const reads = new WeakMap<Context, Map<object, Promise<unknown>>>();
const RAW_BODY = {};
const groupKeys = new WeakMap<object, Record<'body' | 'query' | 'params', object>>();

function once(c: Context, key: object, read: () => Promise<unknown>): Promise<unknown> {
  let cached = reads.get(c);
  if (!cached) reads.set(c, (cached = new Map()));
  let value = cached.get(key);
  if (!value) cached.set(key, (value = read()));
  return value;
}

// A stable key per route contract and request group.
function groupKey(contract: object, group: 'body' | 'query' | 'params'): object {
  let keys = groupKeys.get(contract);
  if (!keys) groupKeys.set(contract, (keys = { body: {}, query: {}, params: {} }));
  return keys[group];
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

/** The schema a `@Body(schema)`-style parameter validates with. */
function parameterSchema(param: ParamMetadata): ValidationSchema | undefined {
  for (const pipe of param.pipes ?? [])
    if (pipe instanceof ValidationPipe && pipe.parser !== undefined) return pipe.parser;
  return undefined;
}

/** The input JSON Schema of a schema that can describe itself; undefined otherwise. */
function describe(schema: ValidationSchema | undefined): JsonObject | undefined {
  if (!schema) return undefined;
  let json: unknown;
  try {
    json = standardJsonSchema(schema, 'input');
    if (json === undefined && 'toJSONSchema' in schema && typeof schema.toJSONSchema === 'function')
      json = 'schema' in schema ? schema.toJSONSchema('input') : schema.toJSONSchema();
    if (json === undefined && 'schema' in schema) return describe(schema.schema);
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

// Parse a form body within the route's limits: every entry is measured (413)
// before any field is interpreted.
async function readFormData(c: Context, body: ResolvedRouteBody): Promise<FormData | undefined> {
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

// Named entries; with declared fields, unknown, repeated and mistyped entries
// answer 400 and a declared array keeps a single entry as an array.
function formRecord(form: FormData, fields: Map<string, FormField> | undefined): FormRecord {
  const result: FormRecord = {};
  for (const [name, value] of form) {
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

/**
 * `@Body()`: JSON by default (415 for other media types), or the form or
 * multipart body the route opts into, bounded by its limits. A `defineRoute`
 * body schema validates here; so does a parameter class carrying a static
 * Standard Schema when the parameter names no schema of its own.
 */
export const readBodyParam: ParamExtractorFactory = (route, param, metatype) => {
  const contract = route.contract;
  const body = contract?.body;
  const group = contract?.bodySchema;
  const own = parameterSchema(param);
  const auto =
    group === undefined && own === undefined ? staticStandardSchema(metatype) : undefined;
  // A whole-body schema declares the form's fields; a named parameter's own
  // schema describes only its member.
  const fields =
    body && body.kind !== 'json'
      ? formFields(
          group ?? (param.name === undefined ? (own ?? auto) : undefined),
          body,
          route.source,
        )
      : undefined;
  const form = body && body.kind !== 'json' ? body : undefined;
  const raw = async (c: Context): Promise<unknown> => {
    if (!form)
      return once(c, RAW_BODY, () =>
        readJsonBody(c, body?.maxBytes === undefined ? {} : { maxBytes: body.maxBytes }),
      );
    const data = await once(c, RAW_BODY, () => readFormData(c, form));
    return data instanceof FormData ? formRecord(data, fields) : undefined;
  };
  if (contract && group) {
    const key = groupKey(contract, 'body');
    return async (c) =>
      pick(await once(c, key, async () => validate(group, await raw(c))), param.name);
  }
  if (auto) return async (c) => pick(await validate(auto, await raw(c)), param.name);
  return async (c) => pick(await raw(c), param.name);
};

// Query keys a schema declares as arrays; `true` when a named parameter's own
// schema is an array.
function arrayKeys(
  schema: ValidationSchema | undefined,
  name: string | undefined,
): Set<string> | true {
  const json = describe(schema);
  if (name !== undefined && !json?.properties) return json?.type === 'array' ? true : new Set();
  return new Set(
    properties(json)
      .filter(([, field]) => field.type === 'array')
      .map(([key]) => key),
  );
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

/**
 * `@Query()`: repeated keys (`?tag=a&tag=b`) and keys the schema declares as
 * arrays arrive as arrays; every other key stays a string.
 */
export const readQueryParam: ParamExtractorFactory = (route, param) => {
  const contract = route.contract;
  const group = contract?.query;
  const arrays = arrayKeys(group ?? parameterSchema(param), group ? undefined : param.name);
  const keys = arrays === true ? new Set<string>() : arrays;
  if (contract && group) {
    const key = groupKey(contract, 'query');
    return async (c) =>
      pick(await once(c, key, () => validate(group, wireQuery(c, keys))), param.name);
  }
  const name = param.name;
  if (name === undefined) return (c) => wireQuery(c, keys);
  return (c) => {
    const values = c.req.queries(name);
    return values && (arrays === true || values.length !== 1) ? values : values?.[0];
  };
};

/** `@Param()`: a `defineRoute` params schema validates the path parameters once. */
export const readPathParam: ParamExtractorFactory = (route, param) => {
  const contract = route.contract;
  const group = contract?.params;
  if (!contract || !group)
    return (c) => (param.name === undefined ? c.req.param() : c.req.param(param.name));
  const key = groupKey(contract, 'params');
  return async (c) => pick(await once(c, key, () => validate(group, c.req.param())), param.name);
};
