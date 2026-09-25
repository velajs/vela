import { z } from 'zod';
import * as v from 'valibot';
import { Get, defineSerializer } from '../index';
import { defineDto } from '../validation/index';

class Account {
  #id: string;
  constructor(id: string) {
    this.#id = id;
  }
  identifier(): string {
    return this.#id;
  }
}

const serializer = defineSerializer({
  input: z.instanceof(Account),
  output: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
  project: (account) => ({ id: account.identifier() }),
});

const transformedInput = defineSerializer({
  input: v.pipe(v.string(), v.transform(Number)),
  output: v.number(),
  project: (value) => value * 2,
});

export async function verifySerializerTypes(raw: unknown): Promise<void> {
  const wire: { id: number } = await serializer.serialize(new Account('42'));
  const parsed: { id: number } = await serializer.parse(raw);
  const transformed: number = await transformedInput.serialize('21');
  // @ts-expect-error Callers provide schema input, not an already transformed domain value.
  transformedInput.serialize(21);
  void transformed;
  void [wire, parsed];

  // @ts-expect-error A typed call requires the validated domain type, including private state.
  serializer.serialize({ identifier: () => '42' });
  // @ts-expect-error Wire output follows the schema's transformation, not project()'s input.
  const wrong: { id: string } = await serializer.serialize(new Account('42'));
  void wrong;

  defineSerializer({
    input: z.instanceof(Account),
    output: v.object({ id: v.string() }),
    // @ts-expect-error The output schema determines projection input; callbacks cannot widen it.
    project: (account) => ({ id: account.identifier().length }),
  });
  defineSerializer({
    input: z.instanceof(Account),
    output: v.string(),
    // @ts-expect-error The input schema determines the domain parameter.
    project: (value: number) => String(value),
  });
}

const asyncSerializer = defineSerializer({
  input: z.unknown().transform(async () => new Account('1')),
  output: z.object({ id: z.string() }).transform(async () => ({ id: 1 })),
  project: (account) => ({ id: account.identifier() }),
});

class Responses {
  @Get('/standard', { response: defineDto(v.object({ id: v.string() })) })
  standard() {
    return { id: 'one' };
  }

  @Get('/projected', { response: serializer })
  projected() {
    return new Account('1');
  }

  @Get('/async', { response: asyncSerializer })
  asyncResponse() {
    return new Account('1');
  }

  // @ts-expect-error A serializer response takes the domain value, not its wire shape.
  @Get('/wire', { response: serializer })
  wire() {
    return { id: 1 };
  }
}
void Responses;
