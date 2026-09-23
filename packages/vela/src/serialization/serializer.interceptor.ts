import { Injectable } from '../container/decorators';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { isValidationSchema, parseSchemaAsync } from '../validation';
import { SERIALIZE_METADATA } from './serialize.decorator';

@Injectable()
export class SerializerInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const result = await next.handle();
    const controller = context.getClass();
    const handler = context.getHandler();

    const dto = MetadataRegistry.getCustomHandlerMeta(controller, handler, SERIALIZE_METADATA);
    if (dto === undefined) return result;
    if (
      dto === null ||
      (typeof dto !== 'object' && typeof dto !== 'function') ||
      !('schema' in dto) ||
      !isValidationSchema(dto.schema)
    ) {
      throw new TypeError('Invalid @Serialize descriptor: expected a supported schema.');
    }
    const schema = dto.schema;

    if (Array.isArray(result)) {
      return Promise.all(result.map((item) => parseSchemaAsync(schema, item)));
    }
    return parseSchemaAsync(schema, result);
  }
}
