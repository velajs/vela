import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Put,
  UseInterceptors,
  VelaFactory,
  type CallHandler,
  type NestInterceptor,
  type VelaApplication,
} from '../index';
import { defineDto, type SchemaOutput } from '../validation/index';

const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
const CreateTodo = z.object({ title: z.string().min(1) });

async function serve(...controllers: Array<new (...args: never[]) => object>) {
  @Module({ controllers })
  class App {}
  return VelaFactory.create(App);
}

async function call(app: VelaApplication, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`https://example.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
}

describe('route success status', () => {
  it('answers 201 for POST, 200 for other methods and keeps an empty result at that status', async () => {
    @Controller('/items')
    class Items {
      @Post()
      create() {
        return { created: true };
      }
      @Post('/empty')
      createEmpty() {}
      @Get()
      list() {}
      @Put('/:id')
      replace() {
        return null;
      }
      @Patch('/:id')
      update() {
        return { updated: true };
      }
      @Delete('/:id')
      remove() {}
    }
    const app = await serve(Items);
    try {
      const created = await call(app, 'POST', '/items');
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ created: true });
      const empty = await call(app, 'POST', '/items/empty');
      expect(empty.status).toBe(201);
      expect(await empty.text()).toBe('');
      for (const [method, path] of [
        ['GET', '/items'],
        ['PUT', '/items/1'],
        ['PATCH', '/items/1'],
        ['DELETE', '/items/1'],
      ] as const) {
        expect({ method, status: (await call(app, method, path)).status }).toEqual({
          method,
          status: 200,
        });
      }
    } finally {
      await app.close();
    }
  });

  it('answers 204 for response: null and for @HttpCode(204), and honours a declared status', async () => {
    @Controller('/items')
    class Items {
      @Delete('/:id', { response: null })
      remove() {}
      @Post('/purge')
      @HttpCode(204)
      purge() {
        return { ignored: true };
      }
      @Post('/queue', { status: 202, response: z.object({ queued: z.boolean() }) })
      queue() {
        return { queued: true };
      }
      @Post('/accepted', { response: null, status: 202 })
      accept() {}
    }
    const app = await serve(Items);
    try {
      const removed = await call(app, 'DELETE', '/items/1');
      expect(removed.status).toBe(204);
      expect(await removed.text()).toBe('');
      const purged = await call(app, 'POST', '/items/purge');
      expect(purged.status).toBe(204);
      expect(await purged.text()).toBe('');
      const queued = await call(app, 'POST', '/items/queue');
      expect(queued.status).toBe(202);
      expect(await queued.json()).toEqual({ queued: true });
      const accepted = await call(app, 'POST', '/items/accepted');
      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe('');
    } finally {
      await app.close();
    }
  });
});

describe('route response schemas', () => {
  it('parses the result through the response schema, stripping undeclared fields', async () => {
    @Controller('/todos')
    class Todos {
      @Post({ response: Todo })
      create(@Body(CreateTodo) body: SchemaOutput<typeof CreateTodo>) {
        return { id: 't1', title: body.title, done: false, secret: 'internal' };
      }
      @Get('/:id', { response: Todo })
      find(@Param('id') id: string) {
        return { id, title: 'Read', done: true, owner: 'hidden' };
      }
    }
    const app = await serve(Todos);
    try {
      const created = await call(app, 'POST', '/todos', { title: 'Ship' });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ id: 't1', title: 'Ship', done: false });
      const found = await call(app, 'GET', '/todos/t9');
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({ id: 't9', title: 'Read', done: true });
    } finally {
      await app.close();
    }
  });

  it('answers 500 without leaking the value when the result breaks its response schema', async () => {
    const leaky = z.object({ id: z.string() });
    @Controller('/broken')
    class Broken {
      @Get({ response: leaky })
      // The declared return type satisfies the schema; the runtime value does not.
      read(): { id: string } {
        return JSON.parse('{"id":42,"secret":"do-not-send"}');
      }
    }
    const app = await serve(Broken);
    try {
      const response = await call(app, 'GET', '/broken');
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain('do-not-send');
      expect(text).not.toContain('42');
    } finally {
      await app.close();
    }
  });

  it('validates the final interceptor result, keeps JSON strings and null, and skips parsing with validate: false', async () => {
    @Injectable()
    class Wrap implements NestInterceptor {
      async intercept(_context: unknown, next: CallHandler) {
        const result = await next.handle();
        return { ...Object(result), wrapped: 'yes' };
      }
    }
    const Wrapped = z.object({ value: z.string(), wrapped: z.string() });
    @Controller('/values')
    class Values {
      @Get('/wrapped', { response: Wrapped })
      @UseInterceptors(Wrap)
      wrapped() {
        return { value: 'inner', wrapped: 'no' };
      }
      @Get('/string', { response: z.string() })
      string() {
        return 'plain';
      }
      @Get('/null', { response: z.null() })
      nothing() {
        return null;
      }
      @Get('/trusted', { response: Todo, validate: false })
      trusted() {
        return { id: 'x', title: 'T', done: false, extra: 'kept' };
      }
    }
    @Module({ controllers: [Values], providers: [Wrap] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(await (await call(app, 'GET', '/values/wrapped')).json()).toEqual({
        value: 'inner',
        wrapped: 'yes',
      });
      const string = await call(app, 'GET', '/values/string');
      expect(string.headers.get('content-type')).toContain('application/json');
      expect(await string.json()).toBe('plain');
      const nothing = await call(app, 'GET', '/values/null');
      expect(nothing.status).toBe(200);
      expect(await nothing.json()).toBeNull();
      expect(await (await call(app, 'GET', '/values/trusted')).json()).toEqual({
        id: 'x',
        title: 'T',
        done: false,
        extra: 'kept',
      });
    } finally {
      await app.close();
    }
  });

  it('accepts parse() parsers and defineDto descriptors as response schemas', async () => {
    const dto = defineDto(Todo, { name: 'Todo' });
    const parser = { parse: (value: unknown) => ({ echoed: String(Object(value).raw) }) };
    @Controller('/schemas')
    class Schemas {
      @Get('/dto', { response: dto })
      dto() {
        return { id: 'd', title: 'Dto', done: true, hidden: 1 };
      }
      @Get('/parser', { response: parser })
      parser() {
        return { echoed: 'unused' };
      }
    }
    const app = await serve(Schemas);
    try {
      expect(await (await call(app, 'GET', '/schemas/dto')).json()).toEqual({
        id: 'd',
        title: 'Dto',
        done: true,
      });
      expect(await (await call(app, 'GET', '/schemas/parser')).json()).toEqual({
        echoed: 'undefined',
      });
    } finally {
      await app.close();
    }
  });
});

describe('route response formats', () => {
  it('sends text, binary, stream and native responses in the declared format', async () => {
    @Controller('/files')
    class Files {
      @Get('/note', { format: 'text' })
      note() {
        return 'hello';
      }
      @Get('/blob', { format: 'binary', contentType: 'application/pdf' })
      blob() {
        return new Blob(['%PDF']);
      }
      @Get('/stream', { format: 'stream', contentType: 'text/event-stream' })
      stream() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: one\n\n'));
            controller.close();
          },
        });
      }
      @Post('/raw', { format: 'response' })
      raw() {
        return Response.json({ native: true }, { status: 202, headers: { 'x-native': '1' } });
      }
    }
    const app = await serve(Files);
    try {
      const note = await call(app, 'GET', '/files/note');
      expect(note.headers.get('content-type')).toContain('text/plain');
      expect(await note.text()).toBe('hello');
      const blob = await call(app, 'GET', '/files/blob');
      expect(blob.headers.get('content-type')).toBe('application/pdf');
      expect(await blob.text()).toBe('%PDF');
      const stream = await call(app, 'GET', '/files/stream');
      expect(stream.headers.get('content-type')).toBe('text/event-stream');
      expect(await stream.text()).toBe('data: one\n\n');
      const raw = await call(app, 'POST', '/files/raw');
      expect(raw.status).toBe(202);
      expect(raw.headers.get('x-native')).toBe('1');
      expect(await raw.json()).toEqual({ native: true });
    } finally {
      await app.close();
    }
  });

  it('rejects contradictory declarations when the class is defined or the application starts', async () => {
    expect(() => Post('/', { format: 'stream', response: Todo })).toThrow(/native body/);
    expect(() => Get('/', { contentType: 'text/csv' })).toThrow(/contentType applies/);
    expect(() => Get('/', { format: 'binary', contentType: 'text/csv; charset=utf-8' })).toThrow(
      /media type/,
    );
    expect(() => Post('/', { response: Todo, status: 204 })).toThrow(/response: null/);
    expect(() => Get('/', { body: { json: {} } })).toThrow(/no request body/);
    expect(() => Post('/', { body: { multipart: { maxFiles: 0 } } })).toThrow(/positive/);
    // @ts-expect-error URL-encoded forms carry no files
    expect(() => Post('/', { body: { form: { maxFileBytes: 10 } } })).toThrow(/multipart/);

    @Controller('/twice')
    class Twice {
      @Post({ status: 202 })
      @HttpCode(200)
      create() {
        return {};
      }
    }
    await expect(serve(Twice)).rejects.toThrow(/status once/);
  });
});
