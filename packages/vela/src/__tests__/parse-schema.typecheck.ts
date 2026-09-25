import { z } from 'zod';
import * as v from 'valibot';
import {
  defineDto,
  parseSchemaAsync,
  type SchemaInput,
  type SchemaOutput,
  type DtoDefinition,
} from '../validation';

const transformed = defineDto(z.string().transform((value) => value.length));
const standard = defineDto(v.pipe(v.string(), v.transform(Number)));
export async function checkSharedSchemaTypes(): Promise<void> {
  const input: SchemaInput<typeof transformed> = 'wire';
  const output: SchemaOutput<typeof transformed> = 4;
  const parsed: number = await parseSchemaAsync(transformed, input);
  const parsedDescriptor: number = await transformed.parseAsync('four');
  const standardInput: SchemaInput<typeof standard> = '42';
  const standardOutput: number = await standard.parseAsync(standardInput);
  // @ts-expect-error Parser-only validators are not Standard Schema.
  defineDto({ parse: () => 1 });
  const explicitStandard = defineDto(standard.schema);
  // @ts-expect-error Wire strings are not the parsed output.
  const wrongInput: SchemaInput<typeof transformed> = 1;
  // @ts-expect-error Parsed output is numeric.
  const wrongOutput: SchemaOutput<typeof transformed> = '1';
  // @ts-expect-error No consumer-selected return type.
  const wrongParsed: string = await parseSchemaAsync(transformed, 'wire');
  void [
    output,
    parsed,
    parsedDescriptor,
    standardOutput,
    explicitStandard,
    wrongInput,
    wrongOutput,
    wrongParsed,
  ];
}

export const standardDescriptor: DtoDefinition<typeof standard.schema> = {
  name: 'Standard',
  schema: standard.schema,
  parse: () => 1,
  parseAsync: async () => 1,
  toJSONSchema: () => ({ type: 'number' }),
};
