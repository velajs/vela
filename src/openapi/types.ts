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
  content?: Record<string, { schema: JsonSchema }>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export type HttpVerb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

export type OpenApiPathItem = {
  [verb in HttpVerb]?: OpenApiOperation;
};

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
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
  /** Zod schema, DTO class (from createZodDto), or raw JSON Schema. */
  schema?: unknown;
}

export interface ApiResponseEntry extends ApiResponseOptions {
  status: number | string;
}

export interface CreateOpenApiDocumentOptions {
  info?: Partial<OpenApiInfo>;
  globalPrefix?: string;
  /**
   * Declare top-level tag groups with descriptions and an explicit order
   * (mirrors NestJS `DocumentBuilder().addTag(name, description)`). Tags
   * actually used by operations but NOT declared here are still emitted —
   * appended after the declared ones in first-seen order. Declared tags
   * with no operations are kept (lets you pre-declare ordering/description).
   */
  tags?: Array<{ name: string; description?: string }>;
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
