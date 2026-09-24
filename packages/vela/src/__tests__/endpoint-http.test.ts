import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  UseGuards,
  UseInterceptors,
  VelaFactory,
} from '../index';
import { Endpoint, defineEndpoint } from '../openapi/index';
import { ValidationPipe } from '../validation/index';
import type { CanActivate, NestInterceptor } from '../index';

describe('schema-bound HTTP endpoints', () => {
  it('applies a transforming input parser once with a global ValidationPipe', async () => {
    let parses = 0;
    const wire = z.object({ json: z.object({ count: z.string().regex(/^\d+$/) }) });
    const input = {
      parse(value: unknown) {
        parses += 1;
        return { json: { count: Number(wire.parse(value).json.count) } };
      },
      toJSONSchema: () => wire.toJSONSchema(),
    };
    const definition = defineEndpoint({ input, output: z.number() });
    @Controller('/transform')
    class Transform {
      @Post()
      @Endpoint(definition)
      create(value: ReturnType<typeof input.parse>) {
        return value.json.count;
      }
    }
    @Module({ controllers: [Transform] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    const response = await app.getHonoApp().request('/transform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: '12' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(12);
    expect(parses).toBe(1);
    await app.close();
  });

  it('retains explicit text responses in the shared contract', async () => {
    const definition = defineEndpoint({ input: z.object({}), output: z.string(), format: 'text' });
    @Controller('/text')
    class Text {
      @Get()
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return 'ready';
      }
    }
    @Module({ controllers: [Text] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app.getHonoApp().request('/text');
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('ready');
    await app.close();
  });
  it('parses wire groups and preserves single/repeated array query parameters', async () => {
    const definition = defineEndpoint({
      input: z.object({
        param: z.object({ id: z.string() }),
        query: z.object({ tag: z.array(z.string()), limit: z.coerce.number().int().default(10) }),
        header: z.object({ 'x-example': z.string() }),
      }),
      output: z.object({
        id: z.string(),
        tags: z.array(z.string()),
        limit: z.number(),
        header: z.string(),
      }),
    });
    @Controller('/items')
    class Items {
      @Get('/:id')
      @Endpoint(definition)
      read(input: ReturnType<typeof definition.input.parse>) {
        return {
          id: input.param.id,
          tags: input.query.tag,
          limit: input.query.limit,
          header: input.header['x-example'],
        };
      }
    }
    @Module({ controllers: [Items] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app
      .getHonoApp()
      .request('/items/a?tag=one', { headers: { 'x-example': 'yes' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'a', tags: ['one'], limit: 10, header: 'yes' });
    const repeated = await app
      .getHonoApp()
      .request('/items/b?tag=one&tag=two&limit=2', { headers: { 'x-example': 'yes' } });
    expect(await repeated.json()).toMatchObject({ tags: ['one', 'two'], limit: 2 });
    const duplicateScalar = await app
      .getHonoApp()
      .request('/items/a?tag=one&limit=1&limit=2', { headers: { 'x-example': 'yes' } });
    expect(duplicateScalar.status).toBe(400);
    await app.close();
  });

  it('guards run before malformed body parsing and endpoint input validation', async () => {
    const definition = defineEndpoint({
      input: z.object({ json: z.object({ name: z.string() }) }),
      output: z.string(),
    });
    @Injectable()
    class Deny implements CanActivate {
      canActivate() {
        return false;
      }
    }
    @Controller('/guarded')
    class Guarded {
      @Post()
      @UseGuards(Deny)
      @Endpoint(definition)
      create(input: ReturnType<typeof definition.input.parse>) {
        return input.json.name;
      }
    }
    @Module({ controllers: [Guarded], providers: [Deny] })
    class App {}
    const app = await VelaFactory.create(App);
    const response = await app.getHonoApp().request('/guarded', { method: 'POST', body: '{bad' });
    expect(response.status).toBe(403);
    await app.close();
  });

  it('rejects invalid input, parses valid bodies, and sends JSON strings at the declared status', async () => {
    const definition = defineEndpoint({
      input: z.object({ json: z.object({ name: z.string() }) }),
      output: z.string(),
      status: 201,
    });
    @Controller('/create')
    class Create {
      @Post()
      @Endpoint(definition)
      create(input: ReturnType<typeof definition.input.parse>) {
        return input.json.name;
      }
    }
    @Module({ controllers: [Create] })
    class App {}
    const app = await VelaFactory.create(App);
    const headers = { 'content-type': 'application/json' };
    for (const body of ['{bad', '{}', '{"name":42}']) {
      expect(
        (await app.getHonoApp().request('/create', { method: 'POST', headers, body })).status,
      ).toBe(400);
    }
    const response = await app
      .getHonoApp()
      .request('/create', { method: 'POST', headers, body: '{"name":"Ada"}' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toBe('Ada');
    await app.close();
  });

  it('validates interceptor output before returning it and preserves JSON null', async () => {
    const definition = defineEndpoint({
      input: z.object({}),
      output: z.object({ id: z.string() }),
    });
    const nullDefinition = defineEndpoint({ input: z.object({}), output: z.null() });
    @Injectable()
    class Corrupt implements NestInterceptor {
      async intercept() {
        return { id: 42 };
      }
    }
    @Controller('/output')
    class Output {
      @Get('/invalid')
      @UseInterceptors(Corrupt)
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return { id: 'ok' };
      }
      @Get('/null')
      @Endpoint(nullDefinition)
      empty(_input: ReturnType<typeof nullDefinition.input.parse>) {
        return null;
      }
    }
    @Module({ controllers: [Output], providers: [Corrupt] })
    class App {}
    const app = await VelaFactory.create(App);
    expect((await app.getHonoApp().request('/output/invalid')).status).toBe(500);
    const response = await app.getHonoApp().request('/output/null');
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    await app.close();
  });

  it('rejects competing response and parameter declarations during bootstrap', async () => {
    const definition = defineEndpoint({ input: z.object({}), output: z.string() });
    @Controller('/conflict')
    class Conflict {
      @Get()
      @HttpCode(202)
      @Endpoint(definition)
      read(_input: ReturnType<typeof definition.input.parse>) {
        return 'value';
      }
    }
    @Module({ controllers: [Conflict] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow('@Endpoint owns');
    @Controller('/parameter')
    class Parameter {
      @Post()
      @Endpoint(definition)
      read(@Body() _input: ReturnType<typeof definition.input.parse>) {
        return 'value';
      }
    }
    @Module({ controllers: [Parameter] })
    class ParameterApp {}
    await expect(VelaFactory.create(ParameterApp)).rejects.toThrow('@Endpoint owns');
  });
});
