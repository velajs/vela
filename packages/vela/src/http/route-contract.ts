import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { SchemaInput, SchemaOutput, ValidationSchema } from '../validation/parse-schema';
import type { StandardSchemaV1 } from '../validation/standard-schema';

/**
 * How a route sends its result: `json` (the default), `text`, or a native
 * body — `binary` (Blob, ArrayBuffer or Uint8Array), `stream` (a
 * ReadableStream) or `response` (a Response). A handler may always return a
 * ready `Response`, which is sent as is.
 */
export type RouteResponseFormat = 'json' | 'text' | 'binary' | 'stream' | 'response';

/** Limits for a JSON body. `maxBytes` replaces the application's body limit for the route. */
export interface RouteJsonBody {
  maxBytes?: number;
}

/**
 * Limits for an `application/x-www-form-urlencoded` body. Every entry counts,
 * including repeated and unknown fields. Defaults: `maxBytes` 1 MiB,
 * `maxFields` 100, `maxFieldBytes` 64 KiB (UTF-8 bytes of the name and value).
 */
export interface RouteFormBody {
  maxBytes?: number;
  maxFields?: number;
  maxFieldBytes?: number;
}

/**
 * Limits for a `multipart/form-data` body. Defaults: `maxFiles` 1,
 * `maxFileBytes` 1 MiB, `maxFields` 100 text entries, `maxFieldBytes` 64 KiB,
 * and `maxBytes` — the whole encoded body — `maxFiles × maxFileBytes` plus
 * 1 MiB for text fields and multipart framing.
 */
export interface RouteMultipartBody extends RouteFormBody {
  maxFiles?: number;
  maxFileBytes?: number;
}

/**
 * The body a route accepts. Routes read JSON by default (other media types
 * answer 415); `form` and `multipart` opt the route into those encodings
 * instead. A declared body is read and checked after guards, before the
 * handler, whether or not a parameter reads it. The route's own `maxBytes`
 * replaces the application's body limit for that route; a default `maxBytes`
 * never exceeds a limit the application configures. A matching
 * `security.body.streamingOverrides` entry still takes precedence.
 */
export type RouteBodyOptions =
  | { readonly json: RouteJsonBody }
  | { readonly form: RouteFormBody }
  | { readonly multipart: RouteMultipartBody };

/** What a route sends on success. Decorator options and `defineRoute` contracts share it. */
export interface RouteResponseOptions {
  /**
   * Schema of the success body. The route parses the handler's result through
   * it — so a stripping schema removes undeclared fields — documents it in
   * OpenAPI and types generated clients; a handler whose return type does not
   * match fails to compile. `null` declares an empty body, sent as 204 unless
   * `status` says otherwise.
   */
  response?: ValidationSchema | null;
  /** Success status. Defaults to 201 for POST, 204 for `response: null`, 200 otherwise. */
  status?: SuccessStatusCode;
  /**
   * How the result is sent: `json` by default with a `response` schema.
   * Without one, strings are sent as text and other values as JSON, as on a
   * route without options.
   */
  format?: RouteResponseFormat;
  /** Media type of a `binary`, `stream` or `response` body; `application/octet-stream` by default. */
  contentType?: string;
  /** Parse the result through `response` before sending it (default `true`). */
  validate?: boolean;
}

/** Native bodies a `binary` route sends. */
export type RouteBinaryBody = Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;

/**
 * What a handler returns for a response schema: the schema's input, which it
 * turns into the body (a schema that transforms receives the domain value).
 */
export type RouteSchemaResult<S extends ValidationSchema> = S extends {
  readonly schema: infer Inner extends ValidationSchema;
}
  ? RouteSchemaResult<Inner>
  : S extends StandardSchemaV1
    ? SchemaInput<S>
    : SchemaOutput<S>;

/**
 * What a handler with these route options or contract returns. A ready
 * `Response` is always accepted and sent as is.
 */
export type RouteHandlerResult<Options> = Options extends { readonly format: 'response' }
  ? Response
  : Options extends { readonly format: 'stream' }
    ? ReadableStream<Uint8Array> | Response
    : Options extends { readonly format: 'binary' }
      ? RouteBinaryBody | Response
      : Options extends { readonly response: null }
        ? undefined | null | void | Response
        : Options extends { readonly response: infer S extends ValidationSchema }
          ? Options extends { readonly format: 'text' }
            ? Extract<RouteSchemaResult<S>, string> | Response
            : RouteSchemaResult<S> | Response
          : Options extends { readonly format: 'text' }
            ? string | Response
            : unknown;

/** A route body with every limit resolved. */
export interface ResolvedRouteBody {
  readonly kind: 'json' | 'form' | 'multipart';
  /** Undefined for JSON without its own limit: the application's limit applies. */
  readonly maxBytes?: number;
  /**
   * The route set `maxBytes` itself, so it replaces the application's limit;
   * a default `maxBytes` never exceeds a limit the application configures.
   */
  readonly explicitMaxBytes: boolean;
  readonly maxFields: number;
  readonly maxFieldBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

/**
 * What a route declares beyond its path, recorded on the route. Decorator
 * options and `defineRoute` contracts resolve to the same shape, so both
 * validate, document and type a route identically.
 */
export interface RouteContractMetadata {
  /** The success body schema; `null` declares an empty body (204 by default). */
  readonly response?: ValidationSchema | null;
  readonly status?: SuccessStatusCode;
  /**
   * The declared format, `json` when only `response` is declared. Undefined
   * sends strings as text and other values as JSON, as a route without options.
   */
  readonly format?: RouteResponseFormat;
  /** Media type of a native body. */
  readonly contentType?: string;
  /** Parse the handler's result through `response` before sending it. */
  readonly validate: boolean;
  readonly body?: ResolvedRouteBody;
  /**
   * Request schemas a `defineRoute` contract declares, validated once per
   * request after guards, whether or not a parameter reads them.
   */
  readonly params?: ValidationSchema;
  readonly query?: ValidationSchema;
  readonly bodySchema?: ValidationSchema;
  /** The served path a `defineRoute` contract declares. */
  readonly path?: string;
  /**
   * Declared by a `defineRoute` contract, whose client types fix the status:
   * the route takes no `@HttpCode`.
   */
  readonly shared?: boolean;
}

const MiB = 1024 * 1024;
const NATIVE = ['binary', 'stream', 'response'];

function fail(message: string): never {
  throw new TypeError(`Route ${message}`);
}

function limit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    fail('body limits must be positive safe integers');
  return value as number;
}

function resolveBody(options?: Record<string, unknown>): ResolvedRouteBody | undefined {
  const kinds = (['json', 'form', 'multipart'] as const).filter((kind) => options?.[kind] != null);
  if (kinds.length > 1) fail('body takes one of json, form or multipart');
  const kind = kinds[0];
  if (!kind) return undefined;
  const given = Object(options![kind]) as RouteMultipartBody;
  const files = kind === 'multipart';
  if (!files && (given.maxFiles ?? given.maxFileBytes) !== undefined)
    fail(`${kind} bodies carry no files; use multipart`);
  const maxFiles = files ? limit(given.maxFiles, 1) : 0;
  const maxFileBytes = files ? limit(given.maxFileBytes, MiB) : 0;
  return Object.freeze({
    kind,
    maxBytes:
      kind === 'json' && given.maxBytes === undefined
        ? undefined
        : limit(given.maxBytes, maxFiles * maxFileBytes + MiB),
    explicitMaxBytes: given.maxBytes !== undefined,
    maxFields: limit(given.maxFields, 100),
    maxFieldBytes: limit(given.maxFieldBytes, 64 * 1024),
    maxFiles,
    maxFileBytes,
  });
}

/**
 * Resolve a method decorator's options — or a `defineRoute` contract, which
 * carries its `method` — into the route's contract. Undefined for a route
 * that declares nothing beyond its name. Declarations are checked here, so a
 * mistake fails when the class is defined.
 */
export function resolveRouteContract(
  method: string,
  options: object,
): RouteContractMetadata | undefined {
  const given = options as Record<string, unknown> & RouteResponseOptions;
  const contract = 'method' in given;
  if (contract && given.method !== method)
    fail(`contract for ${String(given.method)} cannot be served by @${method}`);
  const pick = (key: string) =>
    contract ? (given[key] as ValidationSchema | undefined) : undefined;
  const { response, status, contentType, validate } = given;
  const format = given.format ?? 'json';
  const native = NATIVE.includes(format);
  const declared = {
    response,
    status,
    format: given.format,
    contentType,
    validate,
    body: resolveBody((contract ? given : given.body) as Record<string, unknown> | undefined),
    params: pick('params'),
    query: pick('query'),
    bodySchema: pick('body'),
    path: contract ? (given.path as string | undefined) : undefined,
    shared: contract || undefined,
  };
  if (!native && format !== 'json' && format !== 'text') fail(`format ${format} is unknown`);
  if (native && response != null)
    fail(`format ${format} sends a native body and takes no response schema`);
  if (contentType !== undefined && !(native && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)))
    fail('contentType applies to binary, stream and response formats, as a media type');
  if (status !== undefined && !(Number.isInteger(status) && status >= 200 && status <= 299))
    fail('status must be a 2xx status');
  if ((status === 204 || status === 205) && response != null)
    fail(`status ${status} has no body; declare response: null`);
  if ((declared.body || declared.bodySchema) && (method === 'GET' || method === 'HEAD'))
    fail(`@${method} routes take no request body`);
  if (declared.path !== undefined && !String(declared.path).startsWith('/'))
    fail('contract path must start with /');
  if (Object.values(declared).every((value) => value === undefined)) return undefined;
  return Object.freeze({
    ...declared,
    format: given.format ?? (response == null ? undefined : 'json'),
    contentType: contentType?.toLowerCase(),
    validate: validate !== false,
  });
}

/** The success status a route sends when `@HttpCode` does not set one. */
export function defaultRouteStatus(
  method: string,
  contract: RouteContractMetadata | undefined,
): SuccessStatusCode {
  return contract?.status ?? (contract?.response === null ? 204 : method === 'POST' ? 201 : 200);
}
