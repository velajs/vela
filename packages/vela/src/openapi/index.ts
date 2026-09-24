// @velajs/vela/openapi — OpenAPI documents and `OpenApiModule`, `@Endpoint`
// contracts and the `@ApiDoc`/`@ApiTags`/`@ApiResponse`/`@ApiExclude` decorators.
import '../metadata';

export { createOpenApiDocument } from './document';
export { OpenApiModule } from './openapi.module';
export type { OpenApiModuleOptions } from './openapi.module';
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
export { ApiDoc, ApiExclude, ApiTags, ApiResponse, isApiExcluded } from './decorators';
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
