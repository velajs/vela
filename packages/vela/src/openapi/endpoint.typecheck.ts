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

// A Standard schema's handler output is its input domain, not its wire output.
import * as v from 'valibot';
import { defineDto, type SchemaInput, type SchemaOutput } from '../validation';
class DomainValue {
  readonly #value = 42;
  get value() {
    return this.#value;
  }
}
const asyncInput = defineDto(
  v.objectAsync({
    json: v.objectAsync({
      value: v.pipeAsync(
        v.string(),
        v.transformAsync(async (value) => Number(value)),
      ),
    }),
  }),
  { jsonSchema: {} },
);
const domainOutput = defineDto(
  v.pipe(
    v.instance(DomainValue),
    v.transform((value) => ({ value: value.value })),
  ),
  { jsonSchema: {} },
);
export function checkTransformEndpointTypes(): void {
  const endpoint = defineEndpoint({ input: asyncInput, output: domainOutput });
  const bound = endpoint.bind((input) => {
    const amount: number = input.json.value;
    void amount;
    return new DomainValue();
  });
  const output: Promise<{ value: number }> = bound({ json: { value: '42' } });
  const wire: SchemaInput<typeof endpoint.input> = { json: { value: '42' } };
  const parsed: SchemaOutput<typeof endpoint.input> = { json: { value: 42 } };
  // @ts-expect-error Handler returns domain input; schema owns wire projection.
  endpoint.bind(() => ({ value: 42 }));
  // @ts-expect-error Parsed input is numeric.
  endpoint.bind((_input: { json: { value: string } }) => new DomainValue());
  // @ts-expect-error Declared output is not text.
  defineEndpoint({ input: asyncInput, output: domainOutput, format: 'text' });
  class Correct {
    @Endpoint(endpoint)
    execute(input: { json: { value: number } }) {
      void input;
      return new DomainValue();
    }
  }
  class Incorrect {
    // @ts-expect-error Decorated method cannot bypass domain output validation.
    @Endpoint(endpoint)
    execute(input: { json: { value: number } }) {
      return { value: input.json.value };
    }
  }
  const legacy = defineEndpoint<{ json: string }, number>({
    input: { parse: () => ({ json: 'x' }), toJSONSchema: () => ({ type: 'object' }) },
    output: { parse: () => 1, toJSONSchema: () => ({ type: 'number' }) },
  });
  void [output, wire, parsed, Correct, Incorrect, legacy];
}

export function checkNativeEndpointTypes(): void {
  const input = z.object({ query: z.object({ id: z.string() }) });
  const stream = defineEndpoint({ input, format: 'stream', contentType: 'text/event-stream' });
  stream.bind((value) => new Response(value.query.id));
  stream.bind(() => new ReadableStream<Uint8Array>());
  // @ts-expect-error Streams require byte chunks.
  stream.bind(() => new ReadableStream<string>());
  // @ts-expect-error Stream endpoints cannot return JSON objects.
  stream.bind(() => ({ value: 'json' }));
  const binary = defineEndpoint({ input, format: 'binary' });
  binary.bind(() => new Blob());
  binary.bind(() => new Uint8Array(2));
  binary.bind(() => new ArrayBuffer(2));
  // @ts-expect-error Binary endpoints cannot return a plain string.
  binary.bind(() => 'bytes');
  const response = defineEndpoint({ input, format: 'response' });
  response.bind(() => new Response());
  // @ts-expect-error Native response endpoints require Response, not just its body.
  response.bind(() => new Blob());
  // @ts-expect-error A native output cannot pretend to parse a JSON schema.
  defineEndpoint({ input, format: 'stream', output: z.string() });
  class Native {
    @Endpoint(stream)
    valid(_input: z.output<typeof input>) {
      return new ReadableStream<Uint8Array>();
    }
    // @ts-expect-error Decorators enforce the same native output boundary as bind.
    @Endpoint(stream)
    invalid(_input: z.output<typeof input>) {
      return { arbitrary: 'json' };
    }
  }
  void Native;
}
