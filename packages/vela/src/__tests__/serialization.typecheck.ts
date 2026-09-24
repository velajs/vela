import { z } from 'zod';
import * as v from 'valibot';
import { Serialize, defineSerializer } from '../index';
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
  const nested: { id: number } = await serializer.schema.parse(raw);
  const transformed: number = await transformedInput.serialize('21');
  // @ts-expect-error Callers provide schema input, not an already transformed domain value.
  transformedInput.serialize(21);
  void transformed;
  void [wire, parsed, nested];

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

const asyncLegacy = defineSerializer({
  input: { parse: async (_value: unknown) => new Account('1') },
  output: { parse: async (_value: unknown) => ({ id: 1 }) },
  project: (account) => ({ id: account.identifier() }),
});

class Responses {
  @Serialize(defineDto(v.object({ id: v.string() })))
  standard() {
    return { id: 'one' };
  }

  @Serialize(serializer)
  projected() {
    return new Account('1');
  }

  @Serialize(asyncLegacy)
  legacy() {
    return new Account('1');
  }
}
void Responses;
