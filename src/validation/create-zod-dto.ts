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
  // Computed-property-name idiom: NamedEvaluation reads the property key and
  // stamps `name` on the class at creation, so callers see `MyDto` (or the
  // override) directly in stack traces and OpenAPI output — no post-hoc
  // `Object.defineProperty` patching of the class's `name` slot.
  const className = options.name ?? 'ZodDto';
  const ZodDto = {
    [className]: class {
      static schema = schema;

      constructor(initial?: InferOutput<T>) {
        if (initial && typeof initial === 'object') {
          Object.assign(this, initial);
        }
      }
    },
  }[className];

  return ZodDto as unknown as {
    new (initial?: InferOutput<T>): InferOutput<T>;
    schema: T;
  };
}
