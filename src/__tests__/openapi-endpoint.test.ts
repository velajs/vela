import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, Get, Module } from '../index';
import { defineEndpoint, Endpoint, getEndpointDefinition } from '../openapi/endpoint';
import { createOpenApiDocument } from '../openapi/document';

describe('schema-bearing endpoint definitions', () => {
  const input = z.object({
    param: z.object({ id: z.string() }),
    query: z.object({ tags: z.array(z.string()).optional() }),
  });
  const output = z.object({ id: z.string() });
  const definition = defineEndpoint({ input, output });

  it('parses input before invoking the bound handler', async () => {
    const handler = vi.fn((value: z.infer<typeof input>) => ({ id: value.param.id }));
    const bound = definition.bind(handler);
    await expect(bound({ param: { id: 42 }, query: {} })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await expect(bound({ param: { id: 'u1' }, query: {} })).resolves.toEqual({ id: 'u1' });
  });

  it('validates output after execution and preserves handler this', async () => {
    const checked = defineEndpoint({ input, output: z.object({ id: z.string().min(3) }) });
    const bound = checked.bind(function (this: { suffix: string }, value) {
      return { id: value.param.id + this.suffix };
    });
    await expect(bound.call({ suffix: '' }, { param: { id: 'x' }, query: {} })).rejects.toThrow();
    await expect(bound.call({ suffix: '123' }, { param: { id: 'x' }, query: {} })).resolves.toEqual(
      { id: 'x123' },
    );
  });

  it('exports the same schemas/status used by runtime dispatch', () => {
    @Controller('/typed-users')
    class Users {
      @Get('/:id')
      @Endpoint(definition)
      find(value: z.infer<typeof input>) {
        return { id: value.param.id };
      }
    }
    @Module({ controllers: [Users] })
    class App {}
    const runtime = getEndpointDefinition(Users, 'find');
    expect(runtime?.queryParameters).toEqual([{ name: 'tags', multiple: true }]);
    expect(runtime?.hasJsonBody).toBe(false);
    expect(runtime?.format).toBe('json');
    const operation = createOpenApiDocument(App).paths['/typed-users/{id}']?.get;
    expect(operation?.parameters).toContainEqual({
      name: 'tags',
      in: 'query',
      required: false,
      schema: { type: 'array', items: { type: 'string' } },
    });
    expect(operation?.responses['200']?.content?.['application/json']?.schema).toEqual(
      runtime?.outputSchema,
    );
  });
});
