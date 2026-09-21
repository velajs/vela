import { MetadataRegistry } from '../registry/metadata.registry';
import type { ValidationSchema } from '../validation';

export const SERIALIZE_METADATA = 'vela:serialize';

export interface SerializationDescriptor {
  readonly schema: ValidationSchema;
}

/** Parse each response item through a schema when SerializerInterceptor is active. */
export function Serialize(dto: SerializationDescriptor): MethodDecorator {
  return (target, propertyKey) => {
    MetadataRegistry.setCustomHandlerMeta(
      target.constructor as new (...args: unknown[]) => unknown,
      propertyKey,
      SERIALIZE_METADATA,
      dto,
    );
  };
}
