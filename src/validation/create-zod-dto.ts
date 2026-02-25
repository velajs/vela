interface ZodSchema {
  parse(data: unknown): unknown;
}

export function createZodDto<T extends ZodSchema>(schema: T) {
  class ZodDto {
    static schema = schema;
  }
  return ZodDto as { new (): unknown; schema: T };
}
