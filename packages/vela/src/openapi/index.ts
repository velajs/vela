// @velajs/vela/openapi — OpenAPI documents, `@Endpoint` contracts and the
// `@ApiDoc`/`@ApiTags`/`@ApiResponse` decorators.
import '../metadata';

export { createOpenApiDocument } from './document';
export { defineEndpoint, Endpoint } from './endpoint';
export type {
  EndpointSchema,
  EndpointResponseFormat,
  EndpointResponseOutput,
  EndpointBinaryBody,
  EndpointBodyOptions,
  EndpointBodyContract,
  EndpointFormLimits,
  EndpointFormField,
  EndpointRequest,
  EndpointDefinition,
  EndpointHandlerOutput,
} from './endpoint';
export { ApiDoc, ApiTags, ApiResponse } from './decorators';
export { zodToJsonSchema } from './zod-to-json-schema';
export type {
  ApiDocMetadata,
  ApiResponseEntry,
  ApiResponseOptions,
  CreateOpenApiDocumentOptions,
  HttpVerb,
  JsonSchema,
  MountOpenApiOptions,
  OpenApiUi,
  OpenApiDocument,
  OpenApiInfo,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  OpenApiResponse,
} from './types';
