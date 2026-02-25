import { MetadataRegistry } from '../registry/metadata.registry';

export const SERIALIZE_METADATA = 'vela:serialize';

export function Serialize(
  dto: { schema: { parse(data: unknown): unknown } },
): MethodDecorator {
  return (target, propertyKey) => {
    MetadataRegistry.setCustomHandlerMeta(
      target.constructor as new (...args: unknown[]) => unknown,
      propertyKey,
      SERIALIZE_METADATA,
      dto,
    );
  };
}
