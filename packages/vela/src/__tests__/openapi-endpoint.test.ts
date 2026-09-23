import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Cookie,
  Get,
  HttpCode,
  Ip,
  Module,
  Query,
  Req,
  createLazyParamDecorator,
  createParamDecorator,
} from '../index';
import type { ExecutionContext, VelaContext } from '../index';
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

  it('keeps endpoint context parameters out of the HTTP contract', () => {
    const CurrentActor = createParamDecorator(
      (_data: undefined, context: ExecutionContext) => context.getModuleId() ?? null,
    );
    const DeferredActor = createLazyParamDecorator(() => undefined);
    @Controller('/plain')
    class Plain {
      @Get('/:id')
      @Endpoint(definition)
      find(value: z.infer<typeof input>) {
        return { id: value.param.id };
      }
    }
    @Controller('/contextual')
    class Contextual {
      @Get('/:id')
      @Endpoint(definition)
      find(
        value: z.infer<typeof input>,
        @CurrentActor() _actor: string | null,
        @DeferredActor() _load: () => undefined,
        @Req() _request: VelaContext,
        @Ip() _address: string | null,
        @Cookie('theme') _theme: string | undefined,
      ) {
        return { id: value.param.id };
      }
    }
    @Module({ controllers: [Plain, Contextual] })
    class App {}
    const { paths } = createOpenApiDocument(App);
    const contextual = paths['/contextual/{id}']?.get;
    expect(contextual).toBeDefined();
    expect(contextual).toEqual(paths['/plain/{id}']?.get);
    expect(contextual?.parameters?.map(({ name, in: location }) => `${location}:${name}`)).toEqual([
      'path:id',
      'query:tags',
    ]);
  });

  it('rejects the same endpoint declarations as route building', () => {
    @Controller('/conflicting')
    class Conflicting {
      @Get('/:id')
      @Endpoint(definition)
      find(value: z.infer<typeof input>, @Query('tags') _tags: string) {
        return { id: value.param.id };
      }
    }
    @Module({ controllers: [Conflicting] })
    class App {}
    expect(() => createOpenApiDocument(App)).toThrow(
      'Conflicting.find: parameter 1 uses @Query(), which reads request data the @Endpoint input owns; declare the value in the input query group',
    );

    @Controller('/accepted')
    class Accepted {
      @Get('/:id')
      @HttpCode(202)
      @Endpoint(definition)
      find(value: z.infer<typeof input>) {
        return { id: value.param.id };
      }
    }
    @Module({ controllers: [Accepted] })
    class StatusApp {}
    expect(() => createOpenApiDocument(StatusApp)).toThrow(
      'Accepted.find: @Endpoint owns the response status; remove @HttpCode and @Redirect',
    );
  });
});
