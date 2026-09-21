import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import {
  Controller,
  Endpoint,
  Module,
  Post,
  VelaFactory,
  ValidationPipe,
  UseInterceptors,
  defineDto,
  defineEndpoint,
  createOpenApiDocument,
  type StandardSchemaV1,
} from '../index';

class Amount {
  readonly #value: number;
  constructor(value: number) {
    this.#value = value;
  }
  get value() {
    return this.#value;
  }
}

function fixture() {
  const inputTransform = vi.fn(async (amount: string) => Number(amount));
  const outputTransform = vi.fn(async (amount: Amount) => ({ amount: amount.value }));
  const input = defineDto(
    v.objectAsync({
      json: v.objectAsync({
        amount: v.pipeAsync(v.string(), v.transformAsync(inputTransform)),
      }),
    }),
    {
      schemaConverter: (direction) => ({
        type: 'object',
        properties: {
          json: {
            type: 'object',
            properties: {
              amount: { type: direction === 'input' ? 'string' : 'number' },
            },
          },
        },
      }),
    },
  );
  const output = defineDto(v.pipeAsync(v.instance(Amount), v.transformAsync(outputTransform)), {
    jsonSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  });
  const endpoint = defineEndpoint({ input, output, status: 201 });
  return { endpoint, inputTransform, outputTransform };
}

describe('async endpoint boundaries', () => {
  it('binds parsed input to a domain result and serializes it once', async () => {
    const { endpoint, inputTransform, outputTransform } = fixture();
    const handle = endpoint.bind((input) => new Amount(input.json.amount));
    expect(await handle({ json: { amount: '42' } })).toEqual({ amount: 42 });
    expect(inputTransform).toHaveBeenCalledTimes(1);
    expect(outputTransform).toHaveBeenCalledTimes(1);
    expect(endpoint.inputSchema.properties?.json?.properties?.amount?.type).toBe('string');
    expect(endpoint.outputSchema.properties?.amount?.type).toBe('number');
  });

  it('awaits HTTP input and output in a global pipe pipeline and documents wire shapes', async () => {
    const { endpoint, inputTransform, outputTransform } = fixture();
    @Controller('/amounts')
    class Amounts {
      @Post()
      @Endpoint(endpoint)
      create(input: Awaited<ReturnType<typeof endpoint.input.parse>>) {
        return new Amount(input.json.amount);
      }
    }
    @Module({ controllers: [Amounts] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    try {
      const response = await app.fetch(
        new Request('https://test/amounts', {
          method: 'POST',
          body: JSON.stringify({ amount: '42' }),
        }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ amount: 42 });
      expect(inputTransform).toHaveBeenCalledTimes(1);
      expect(outputTransform).toHaveBeenCalledTimes(1);
      const doc = createOpenApiDocument(App).paths['/amounts']?.post;
      expect(
        doc?.requestBody?.content?.['application/json']?.schema?.properties?.amount?.type,
      ).toBe('string');
      expect(
        doc?.responses['201']?.content?.['application/json']?.schema?.properties?.amount?.type,
      ).toBe('number');
      const invalid = await app.fetch(
        new Request('https://test/amounts', {
          method: 'POST',
          body: JSON.stringify({ amount: false }),
        }),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ errors: [{ path: ['json', 'amount'] }] });
    } finally {
      await app.close();
    }
  });

  it('keeps thrown input validator errors and invalid output internal', async () => {
    const schema: StandardSchemaV1<unknown, {}> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => {
          throw Object.assign(new Error('database unavailable'), {
            issues: [{ message: 'secret' }],
          });
        },
      },
    };
    const broken = defineEndpoint({
      input: defineDto(schema, { jsonSchema: { type: 'object' } }),
      output: z.string(),
    });
    const wrongOutput = defineEndpoint({
      input: z.object({}),
      output: defineDto(v.string(), { jsonSchema: { type: 'string' } }),
    });
    @Controller('/failures')
    class Failures {
      @Post('/input')
      @Endpoint(broken)
      input(_input: unknown) {
        return 'unused';
      }
      @Post('/output')
      @Endpoint(wrongOutput)
      @UseInterceptors({ intercept: async () => 42 })
      output(_input: object) {
        return 'valid handler result';
      }
    }
    @Module({ controllers: [Failures] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      for (const path of ['input', 'output']) {
        const response = await app.fetch(
          new Request(`https://test/failures/${path}`, { method: 'POST' }),
        );
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toMatch(/secret|database unavailable/);
      }
    } finally {
      await app.close();
    }
  });
});

it('executes async Zod endpoint transforms once and preserves directional conversion', async () => {
  const inputTransform = vi.fn(async (value: string) => Number(value));
  const outputTransform = vi.fn(async (value: number) => String(value));
  const definition = defineEndpoint({
    input: defineDto(
      z.object({ json: z.object({ amount: z.string().transform(inputTransform) }) }),
    ),
    output: defineDto(z.number().transform(outputTransform), { jsonSchema: { type: 'string' } }),
  });
  expect(definition.inputSchema.properties?.json?.properties?.amount?.type).toBe('string');
  @Controller('/zod-async')
  class ZodAsync {
    @Post()
    @Endpoint(definition)
    create(input: { json: { amount: number } }) {
      return input.json.amount;
    }
  }
  @Module({ controllers: [ZodAsync] })
  class App {}
  const app = await VelaFactory.create(App);
  try {
    const response = await app.fetch(
      new Request('https://test/zod-async', { method: 'POST', body: '{"amount":"4"}' }),
    );
    expect(await response.json()).toBe('4');
    expect(inputTransform).toHaveBeenCalledTimes(1);
    expect(outputTransform).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
