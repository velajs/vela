import { MetadataRegistry } from '../registry/metadata.registry';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { SERIALIZE_METADATA } from './serialize.decorator';

export class SerializerInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const result = await next.handle();
    const controller = context.getClass();
    const handler = context.getHandler();

    const dto = MetadataRegistry.getCustomHandlerMeta(
      controller,
      handler,
      SERIALIZE_METADATA,
    ) as { schema?: { parse(data: unknown): unknown } } | undefined;

    const schema = dto?.schema;
    if (!schema?.parse) return result;

    if (Array.isArray(result)) {
      return result.map((item) => schema.parse(item));
    }
    return schema.parse(result);
  }
}
