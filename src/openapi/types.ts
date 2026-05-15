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

export interface MountOpenApiOptions {
  /** Pre-built OpenAPI document to serve. */
  document: OpenApiDocument;
  /** Path for the JSON endpoint. Default `/docs.json`. */
  path?: string;
  /** Opt-in UI renderer. Only `scalar` is bundled today. */
  ui?: 'scalar';
  /** Path the UI is served at when `ui` is set. Default `/docs`. */
  uiPath?: string;
}
