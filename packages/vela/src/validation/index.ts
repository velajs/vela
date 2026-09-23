// @velajs/vela/validation — Standard Schema validation, DTOs and ValidationPipe.
import '../metadata';

export { defineDto } from './dto';
export type { DtoDefinition, DtoOptions, DtoSchema, RuntimeParser, SchemaParser } from './dto';
export { ValidationPipe } from './validation.pipe';
export { parseSchema, parseSchemaAsync, isValidationSchema } from './parse-schema';
export type { ValidationSchema, SchemaInput, SchemaOutput } from './parse-schema';
export type { ValidationIssue } from './standard-schema';
export type { StandardDtoDefinition } from './dto';
export {
  isStandardSchema,
  validateSchema,
  standardJsonSchema,
  SchemaValidationError,
} from './standard-schema';
export type { StandardSchemaV1, StandardJSONSchemaV1 } from './standard-schema';
