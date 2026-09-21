import { z } from 'zod';
import * as v from 'valibot';
import {
  defineDto,
  parseSchemaAsync,
  type SchemaInput,
  type SchemaOutput,
  type DtoDefinition,
  type StandardDtoDefinition,
} from '../validation';

const transformed = defineDto(z.string().transform((value) => value.length));
const standard = defineDto(v.pipe(v.string(), v.transform(Number)));
export async function checkSharedSchemaTypes(): Promise<void> {
  const input: SchemaInput<typeof transformed> = 'wire';
  const output: SchemaOutput<typeof transformed> = 4;
  const parsed: number = await parseSchemaAsync(transformed, input);
  const legacySync: number = transformed.parse('four');
  const standardInput: SchemaInput<typeof standard> = '42';
  const standardOutput: number = await standard.parseAsync(standardInput);
  const explicitLegacy = defineDto<number>({ parse: () => 1 });
  const explicitStandard = defineDto<string, number>(standard.schema);
  // @ts-expect-error Wire strings are not the parsed output.
  const wrongInput: SchemaInput<typeof transformed> = 1;
  // @ts-expect-error Parsed output is numeric.
  const wrongOutput: SchemaOutput<typeof transformed> = '1';
  // @ts-expect-error No consumer-selected return type.
  const wrongParsed: string = await parseSchemaAsync(transformed, 'wire');
  void [
    output,
    parsed,
    legacySync,
    standardOutput,
    explicitLegacy,
    explicitStandard,
    wrongInput,
    wrongOutput,
    wrongParsed,
  ];
}

// 1.x consumers may have authored descriptor objects without an async method.
export const legacyDescriptor: DtoDefinition<number> = {
  name: 'Legacy',
  schema: { parse: () => 1 },
  parse: () => 1,
  toJSONSchema: () => ({ type: 'number' }),
};
export const standardDescriptor: StandardDtoDefinition<string, number> = {
  name: 'Standard',
  schema: standard.schema,
  parse: () => 1,
  toJSONSchema: () => ({ type: 'number' }),
};
