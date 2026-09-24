import { hc } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Query,
  VelaFactory,
  defineSerializer,
  type RouteHandlerResult,
} from '../index';
import {
  defineRoute,
  type ContractApp,
  type ContractBody,
  type ContractInput,
  type ContractOutput,
  type ContractParams,
  type ContractQuery,
  type ContractResponse,
  type ContractStatus,
} from '../contract/index';
import type { SchemaOutput } from '../validation/index';

const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean(), at: z.date() });
const CreateTodo = z.object({ title: z.string(), priority: z.number().optional() });
const Search = z.object({
  status: z.enum(['open', 'closed']),
  tag: z.array(z.string()).optional(),
  page: z.coerce.number().optional(),
});
const Upload = z.object({ kind: z.enum(['avatar', 'banner']), file: z.file() });

const list = defineRoute({ method: 'GET', path: '/todos', query: Search, response: z.array(Todo) });
const create = defineRoute({ method: 'POST', path: '/todos', body: CreateTodo, response: Todo });
const read = defineRoute({ method: 'GET', path: '/todos/:id', response: Todo });
const remove = defineRoute({ method: 'DELETE', path: '/todos/:id', response: null });
const upload = defineRoute({
  method: 'POST',
  path: '/todos/:id/files',
  params: z.object({ id: z.uuid() }),
  body: Upload,
  multipart: { maxFiles: 1 },
  response: z.object({ bytes: z.number() }),
  status: 202,
});
const note = defineRoute({ method: 'GET', path: '/todos/:id/note', format: 'text' });
const routes = [list, create, read, remove, upload, note] as const;

describe('route contract types', () => {
  it('infers hc inputs, outputs and statuses from contracts', () => {
    expectTypeOf<ContractInput<typeof list>>().toEqualTypeOf<{
      query: { status: 'open' | 'closed'; tag?: string[]; page?: string };
    }>();
    expectTypeOf<ContractInput<typeof create>>().toEqualTypeOf<{
      json: { title: string; priority?: number | undefined };
    }>();
    expectTypeOf<ContractInput<typeof read>>().toEqualTypeOf<{ param: { id: string } }>();
    expectTypeOf<ContractInput<typeof upload>>().toEqualTypeOf<{
      param: { id: string };
      form: { kind: 'avatar' | 'banner'; file: File | Blob };
    }>();
    // JSON turns the Date into a string, as the generated client documents it.
    expectTypeOf<ContractOutput<typeof read>>().toEqualTypeOf<{
      id: string;
      title: string;
      done: boolean;
      at: string;
    }>();
    expectTypeOf<ContractOutput<typeof remove>>().toEqualTypeOf<never>();
    expectTypeOf<ContractOutput<typeof note>>().toEqualTypeOf<string>();
    expectTypeOf<ContractStatus<typeof create>>().toEqualTypeOf<201>();
    expectTypeOf<ContractStatus<typeof read>>().toEqualTypeOf<200>();
    expectTypeOf<ContractStatus<typeof remove>>().toEqualTypeOf<204>();
    expectTypeOf<ContractStatus<typeof upload>>().toEqualTypeOf<202>();
  });

  it('types the handler values a contract route receives and returns', () => {
    expectTypeOf<ContractBody<typeof create>>().toEqualTypeOf<{
      title: string;
      priority?: number | undefined;
    }>();
    expectTypeOf<ContractQuery<typeof list>>().toEqualTypeOf<SchemaOutput<typeof Search>>();
    expectTypeOf<ContractParams<typeof read>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ContractParams<typeof upload>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ContractResponse<typeof create>>().toEqualTypeOf<SchemaOutput<typeof Todo>>();
    expectTypeOf<RouteHandlerResult<typeof remove>>().toEqualTypeOf<undefined | null | void>();
    expectTypeOf<RouteHandlerResult<{ format: 'stream' }>>().toEqualTypeOf<
      ReadableStream<Uint8Array> | Response
    >();
  });

  it('fails to compile a handler whose result does not match its response', () => {
    class DecoratorStyle {
      @Post({ response: Todo })
      create() {
        return { id: '1', title: 'Ship', done: false, at: new Date(), extra: true };
      }

      @Get('/async', { response: Todo })
      async read() {
        return { id: '1', title: 'Ship', done: false, at: new Date() };
      }

      // @ts-expect-error `done` must be a boolean
      @Get('/wrong', { response: Todo })
      wrong() {
        return { id: '1', title: 'Ship', done: 'no', at: new Date() };
      }

      // @ts-expect-error a route with `response: null` sends no body
      @Delete('/:id', { response: null })
      removeWithBody() {
        return { removed: true };
      }

      // @ts-expect-error a text route returns a string
      @Get('/text', { format: 'text' })
      text() {
        return 42;
      }

      @Get('/stream', { format: 'stream' })
      stream() {
        return new ReadableStream<Uint8Array>();
      }

      @Get('/untyped')
      untyped() {
        return 42;
      }
    }

    class ContractStyle {
      @Post(create)
      create(@Body() body: ContractBody<typeof create>) {
        return { id: '1', title: body.title, done: false, at: new Date() };
      }

      // @ts-expect-error the contract's response needs `at`
      @Get('/:id', read)
      read() {
        return { id: '1', title: 'Ship', done: false };
      }
    }
    expect(() => {
      class WrongMethod {
        // @ts-expect-error a POST contract cannot be served by @Get
        @Get(create)
        wrongMethod() {
          return { id: '1', title: 'Ship', done: false, at: new Date() };
        }
      }
      return WrongMethod;
    }).toThrow(/POST cannot be served by @GET/);

    // A transforming response schema receives the domain value.
    const account = defineSerializer({
      input: z.object({ id: z.string(), secret: z.string() }),
      output: z.object({ id: z.string() }),
      project: (value) => ({ id: value.id }),
    });
    class Serialized {
      @Get({ response: account })
      read() {
        return { id: '1', secret: 's' };
      }
    }
    expect([DecoratorStyle, ContractStyle, Serialized]).toHaveLength(3);
  });

  it('calls a contract-served application through hc with types from the contracts alone', async () => {
    @Controller('/todos')
    class Todos {
      @Get(list)
      list(@Query() query: ContractQuery<typeof list>) {
        return [
          {
            id: 'a',
            title: `${query.status}:${query.tag?.join('+') ?? ''}`,
            done: false,
            at: new Date(0),
          },
        ];
      }
      @Post(create)
      create(@Body() body: ContractBody<typeof create>) {
        return { id: 'b', title: body.title, done: false, at: new Date(0) };
      }
      @Get('/:id', read)
      read(@Param('id') id: string) {
        return { id, title: 'Read', done: true, at: new Date(0) };
      }
      @Delete('/:id', remove)
      remove() {}
      @Post('/:id/files', upload)
      upload(@Body() form: ContractBody<typeof upload>) {
        return { bytes: form.file.size };
      }
      @Get('/:id/note', note)
      note() {
        return 'a note';
      }
    }
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const client = hc<ContractApp<typeof routes>>('https://example.test', {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          app.fetch(new Request(input, init)),
      });
      const listed = await client.todos.$get({ query: { status: 'open', tag: ['x', 'y'] } });
      expectTypeOf(listed.status).toEqualTypeOf<200>();
      const rows = await listed.json();
      expectTypeOf(rows).toEqualTypeOf<
        { id: string; title: string; done: boolean; at: string }[]
      >();
      expect(rows).toEqual([
        { id: 'a', title: 'open:x+y', done: false, at: '1970-01-01T00:00:00.000Z' },
      ]);

      const created = await client.todos.$post({ json: { title: 'Ship' } });
      expectTypeOf(created.status).toEqualTypeOf<201>();
      expect(created.status).toBe(201);
      expect((await created.json()).title).toBe('Ship');

      const found = await client.todos[':id'].$get({ param: { id: 'c' } });
      expect((await found.json()).id).toBe('c');

      const removed = await client.todos[':id'].$delete({ param: { id: 'c' } });
      expectTypeOf(removed.status).toEqualTypeOf<204>();
      expect(removed.status).toBe(204);

      const uploaded = await client.todos[':id'].files.$post({
        param: { id: '2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f' },
        form: { kind: 'avatar', file: new File(['1234'], 'a.txt') },
      });
      expectTypeOf(uploaded.status).toEqualTypeOf<202>();
      expect(await uploaded.json()).toEqual({ bytes: 4 });

      const text = await client.todos[':id'].note.$get({ param: { id: 'c' } });
      expect(await text.text()).toBe('a note');

      if (false as boolean) {
        // @ts-expect-error `status` is an enum on the wire
        await client.todos.$get({ query: { status: 'archived' } });
        // @ts-expect-error the JSON body needs a title
        await client.todos.$post({ json: {} });
        await client.todos[':id'].files.$post({
          param: { id: 'x' },
          // @ts-expect-error a file field takes a File or Blob
          form: { kind: 'avatar', file: 'text' },
        });
      }
    } finally {
      await app.close();
    }
  });
});
