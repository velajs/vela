/* eslint-disable no-console -- Executable verification fixture. */
import { createRpcClient, defineProcedure } from '@velajs/rpc';
import type { ProcedureInput, ProcedureOutput, ProcedureWireInput } from '@velajs/rpc';

// A structural schema fixture requires no validator or framework installation.
function schema<Input, Output>(
  parse: (value: unknown) => Output,
): {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output };
    readonly validate: (value: unknown) => { value: Output };
  };
} {
  return {
    '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value: parse(value) }) },
  };
}
const input = schema<string, number>((value) => Number(value));
const output = schema<number, { value: number }>((value) => ({ value: Number(value) }));
const procedure = defineProcedure({ name: 'consumer.parse', input, output });
const wire: ProcedureWireInput<typeof procedure> = '12';
const parsed: ProcedureInput<typeof procedure> = 12;
const result: ProcedureOutput<typeof procedure> = { value: 12 };
void [parsed, result];
// @ts-expect-error Wire input remains the parser's original input.
const wrongWire: ProcedureWireInput<typeof procedure> = 12;
// @ts-expect-error The consumer sees output after server parsing.
const wrongResult: ProcedureOutput<typeof procedure> = 12;
void [wrongWire, wrongResult];

const client = createRpcClient({
  url: 'https://example.test/rpc',
  fetch: async (request) => {
    const envelope: unknown = await request.json();
    if (!envelope || typeof envelope !== 'object' || !('id' in envelope))
      throw new Error('Missing call ID');
    return Response.json({
      version: 1,
      id: envelope.id,
      procedure: procedure.name,
      ok: true,
      result: { value: 12 },
    });
  },
});
const response = await client.call(procedure, wire);
const value: number = response.value;
if (value !== 12) throw new Error('Portable consumer failed');
console.log('Portable consumer runtime and inferred output passed');
