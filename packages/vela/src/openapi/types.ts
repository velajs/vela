import type { RoutePathOptions } from '../http/route-paths';

// Minimal OpenAPI 3.1 subset Vela emits. Kept intentionally loose (index
// signatures on schemas, open tags array) so users can extend without
// fighting the types. Covers what createOpenApiDocument actually produces.

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: Array<string | number | boolean | null>;
  const?: unknown;
  description?: string;
  nullable?: boolean;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  $ref?: string;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<
    string,
    {
      schema: JsonSchema;
      encoding?: Record<string, { style?: string; explode?: boolean }>;
    }
  >;
  'x-vela-body-limits'?: {
    maxBytes?: number;
    maxFields?: number;
    maxFieldBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
  };
}

export interface OpenApiResponse {
  description: string;
  /** Native consumption; no JSON payload type is asserted. */
  'x-vela-response-format'?: 'binary' | 'stream' | 'response';
  content?: Record<string, { schema: JsonSchema }>;
}

/**
 * A single security requirement: maps a securityScheme name to the scopes it
 * requires (empty array for apiKey/http schemes). An operation- or document-
 * level array is an OR of these objects. Kept as a plain record so callers can
 * build them inline (`{ cookieAuth: [] }`).
 */
export type OpenApiSecurityRequirement = Record<string, string[]>;

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  /** Per-operation security requirements (overrides the document-level array). */
  security?: OpenApiSecurityRequirement[];
}

/** An OpenAPI Server Object. Kept loose so callers can add `variables`. */
export interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, { enum?: string[]; default: string; description?: string }>;
  [key: string]: unknown;
}

/**
 * An OpenAPI Security Scheme Object (apiKey / http / oauth2 / openIdConnect /
 * mutualTLS). Index signature keeps it open so any valid scheme shape passes
 * without fighting the types (mirrors JsonSchema above).
 */
export interface OpenApiSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
  [key: string]: unknown;
}

export type HttpVerb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

export type OpenApiPathItem = {
  [verb in HttpVerb]?: OpenApiOperation;
};

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  security?: OpenApiSecurityRequirement[];
  tags?: Array<{ name: string; description?: string }>;
}

export interface ApiDocMetadata {
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  tags?: string[];
}

export interface ApiResponseOptions {
  description: string;
  /** Concrete documented media type; defaults to JSON or native octet-stream. */
  contentType?: string;
  /** Document a native body without asserting a parsed JSON schema. */
  format?: 'binary' | 'stream' | 'response';
  /** Zod schema, named defineDto descriptor, or raw JSON Schema. */
  schema?: unknown;
}

export interface ApiResponseEntry extends ApiResponseOptions {
  status: number | string;
}

export interface CreateOpenApiDocumentOptions extends RoutePathOptions {
  info?: Partial<OpenApiInfo>;
  /**
   * Declare top-level tag groups with descriptions and an explicit order
   * (mirrors NestJS `DocumentBuilder().addTag(name, description)`). Tags
   * actually used by operations but NOT declared here are still emitted —
   * appended after the declared ones in first-seen order. Declared tags
   * with no operations are kept (lets you pre-declare ordering/description).
   */
  tags?: Array<{ name: string; description?: string }>;
  /**
   * Top-level `servers` array (base URLs the API is served from). Emitted
   * verbatim between `info` and `paths` when non-empty; omitted otherwise.
   */
  servers?: OpenApiServer[];
  /**
   * Named security schemes, emitted under `components.securitySchemes` (merged
   * with generated `components.schemas`). Reference them from `security`.
   */
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  /**
   * Document-level default security requirements (applies to every operation
   * unless the operation overrides it). Emitted verbatim when non-empty.
   */
  security?: OpenApiSecurityRequirement[];
}

export type OpenApiUi = 'swagger' | 'scalar' | 'redoc';

export interface MountOpenApiOptions {
  /** Pre-built OpenAPI document to serve. */
  document: OpenApiDocument;
  /** OpenAPI JSON spec path. @default '/openapi.json' */
  specPath?: string;
  /**
   * UI(s) to mount. 'all' mounts swagger + scalar + redoc.
   * @default 'scalar'
   */
  ui?: OpenApiUi | OpenApiUi[] | 'all';
  /** Swagger UI path. @default '/docs' */
  swaggerPath?: string;
  /** Scalar path. @default '/scalar' */
  scalarPath?: string;
  /** ReDoc path. @default '/redoc' */
  redocPath?: string;
  /** Page title for the UIs. */
  title?: string;
  /** @deprecated use `specPath`. Back-compat alias; if set, overrides specPath default. */
  path?: string;
  /** @deprecated single-UI path override; applies to the single `ui` when a string. */
  uiPath?: string;
}
