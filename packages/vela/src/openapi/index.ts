// @velajs/vela/openapi — OpenAPI documents and `OpenApiModule`, and the
// `@ApiDoc`/`@ApiTags`/`@ApiResponse`/`@ApiExclude` decorators. Routes
// document their request and response schemas through their decorator options
// or `defineRoute` contracts.
import '../metadata';

export { createOpenApiDocument } from './document';
export { OpenApiModule } from './openapi.module';
export type { OpenApiModuleOptions } from './openapi.module';
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
