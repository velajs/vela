// Compiled by the source typecheck; never imported by the runtime entry point.
import { z } from 'zod';
import { defineEndpoint, Endpoint } from './endpoint';

export function checkEndpointTypes(): void {
  const definition = defineEndpoint({
    input: z.object({ json: z.object({ name: z.string() }) }),
    output: z.object({ id: z.string() }),
    status: 201,
  });
  definition.bind((input) => ({ id: input.json.name }));
  definition.bind(async (input) => ({ id: input.json.name }));
  // @ts-expect-error output schema selects string; handler cannot widen it
  definition.bind(() => ({ id: 42 }));
  // @ts-expect-error wrong handler input, schema cannot be widened by bind
  definition.bind((input: { json: { name: number } }) => ({ id: String(input.json.name) }));
  class Valid {
    @Endpoint(definition)
    create(input: { json: { name: string } }) {
      return { id: input.json.name };
    }
  }
  class Invalid {
    // @ts-expect-error annotated schema cannot hide incompatible method output
    @Endpoint(definition)
    create(input: { json: { name: string } }) {
      return { id: input.json.name.length };
    }
  }
  void Valid;
  void Invalid;
}
