interface ZodLikeSchema {
  parse(data: unknown): unknown;
}

type InferOutput<T extends ZodLikeSchema> = ReturnType<T['parse']>;

export interface CreateZodDtoOptions {
  /** Override the generated class name (useful for debugging and OpenAPI). */
  name?: string;
}

export function createZodDto<T extends ZodLikeSchema>(
  schema: T,
  options: CreateZodDtoOptions = {},
) {
  class ZodDto {
    static schema = schema;

    constructor(initial?: InferOutput<T>) {
      if (initial && typeof initial === 'object') {
        Object.assign(this, initial);
      }
    }
  }

  if (options.name) {
    Object.defineProperty(ZodDto, 'name', {
      value: options.name,
      configurable: true,
    });
  }

  return ZodDto as unknown as {
    new (initial?: InferOutput<T>): InferOutput<T>;
    schema: T;
  };
}
