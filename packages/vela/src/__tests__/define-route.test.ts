import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  VelaFactory,
  type PipeTransform,
  type VelaApplication,
} from '../index';
import {
  contractFormEncodings,
  defineRoute,
  type ContractBody,
  type ContractParams,
  type ContractQuery,
} from '../contract/index';
import { ApiResponse, createOpenApiDocument } from '../openapi/index';
import { ValidationPipe, type SchemaOutput } from '../validation/index';

const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
const CreateTodo = z.object({ title: z.string().min(1) });
const TodoId = z.object({ id: z.string().regex(/^t\d+$/) });
const ListTodos = z.object({
  done: z.enum(['true', 'false']).optional(),
  tag: z.array(z.string()).optional(),
});
const Attach = z.object({ label: z.string(), file: z.file() });
const Problem = z.object({ message: z.string() });

// The contracts a browser client shares with the server.
const routes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/todos',
    query: ListTodos,
    response: z.array(Todo),
  }),
  create: defineRoute({ method: 'POST', path: '/api/todos', body: CreateTodo, response: Todo }),
  read: defineRoute({ method: 'GET', path: '/api/todos/:id', params: TodoId, response: Todo }),
  remove: defineRoute({ method: 'DELETE', path: '/api/todos/:id', params: TodoId, response: null }),
  attach: defineRoute({
    method: 'POST',
    path: '/api/todos/:id/files',
    params: TodoId,
    body: Attach,
    multipart: { maxFileBytes: 1024, maxFiles: 1 },
    response: z.object({ label: z.string(), bytes: z.number() }),
  }),
};

let validations = 0;
const counted = defineRoute({
  method: 'PATCH',
  path: '/api/todos/:id',
  params: z.object({
    id: z.string().transform((id) => {
      validations++;
      return id.toUpperCase();
    }),
  }),
  body: z.object({ title: z.string() }),
  response: z.object({ id: z.string(), slug: z.string(), title: z.string() }),
});

// Parameter classes whose static schemas are also the contract's groups; their
// transforms do not accept their own output.
class Stamp {
  static schema = z.object({ at: z.string().transform((at) => at.length) });
  declare at: number;
}
class Page {
  static schema = z.object({ page: z.string().regex(/^\d+$/).transform(Number) });
  declare page: number;
}
class StampId {
  static schema = z.object({ id: z.string().regex(/^\d+$/).transform(Number) });
  declare id: number;
}
const stamps = {
  create: defineRoute({
    method: 'POST',
    path: '/api/stamps',
    body: Stamp.schema,
    response: z.object({ at: z.number() }),
  }),
  list: defineRoute({
    method: 'GET',
    path: '/api/stamps',
    query: Page.schema,
    response: z.object({ page: z.number() }),
  }),
  read: defineRoute({
    method: 'GET',
    path: '/api/stamps/:id',
    params: StampId.schema,
    response: z.object({ id: z.number() }),
  }),
};

// Pipes before a global ValidationPipe: one copies an object value, one
// changes it in place.
class CopyPipe implements PipeTransform {
  transform(value: unknown) {
    return value !== null && typeof value === 'object' ? { ...value } : value;
  }
}
class TouchPipe implements PipeTransform {
  transform(value: unknown) {
    if (value !== null && typeof value === 'object') Reflect.set(value, 'touched', true);
    return value;
  }
}

@Controller('/stamps')
class Stamps {
  @Post(stamps.create)
  create(@Body() body: Stamp) {
    return { at: body.at };
  }

  @Get(stamps.list)
  list(@Query() query: Page) {
    return { page: query.page };
  }

  @Get('/:id', stamps.read)
  read(@Param() params: StampId) {
    return { id: params.id };
  }
}

@Controller('/todos')
class ContractTodos {
  @Get(routes.list)
  list(@Query() query: ContractQuery<typeof routes.list>) {
    return [
      { id: 't1', title: `tags:${(query.tag ?? []).join(',')}`, done: query.done === 'true' },
    ];
  }

  @Post(routes.create)
  create(@Body() body: ContractBody<typeof routes.create>) {
    return { id: 't2', title: body.title, done: false, internal: 'stripped' };
  }

  @Get('/:id', routes.read)
  @ApiResponse({ status: 404, description: 'Not found', schema: Problem })
  read(@Param() params: ContractParams<typeof routes.read>) {
    return { id: params.id, title: 'Read', done: false };
  }

  @Delete('/:id', routes.remove)
  remove(@Param('id') _id: string) {}

  @Post('/:id/files', routes.attach)
  async attach(@Param('id') _id: string, @Body() form: ContractBody<typeof routes.attach>) {
    return { label: form.label, bytes: form.file.size };
  }

  @Patch('/:id', counted)
  rename(
    @Param('id') id: string,
    @Param() params: ContractParams<typeof counted>,
    @Body('title') title: string,
  ) {
    return { id, slug: params.id, title };
  }
}

// The same routes, declared with decorator options and schema arguments.
@Controller('/todos')
class DecoratedTodos {
  @Get({ response: z.array(Todo) })
  list(@Query(ListTodos) query: SchemaOutput<typeof ListTodos>) {
    return [
      { id: 't1', title: `tags:${(query.tag ?? []).join(',')}`, done: query.done === 'true' },
    ];
  }

  @Post({ response: Todo })
  create(@Body(CreateTodo) body: SchemaOutput<typeof CreateTodo>) {
    return { id: 't2', title: body.title, done: false, internal: 'stripped' };
  }

  @Get('/:id', { response: Todo })
  @ApiResponse({ status: 404, description: 'Not found', schema: Problem })
  read(@Param('id', TodoId.shape.id) id: string) {
    return { id, title: 'Read', done: false };
  }

  @Delete('/:id', { response: null })
  remove(@Param('id', TodoId.shape.id) _id: string) {}

  @Post('/:id/files', {
    response: z.object({ label: z.string(), bytes: z.number() }),
    body: { multipart: { maxFileBytes: 1024, maxFiles: 1 } },
  })
  async attach(
    @Param('id', TodoId.shape.id) _id: string,
    @Body(Attach) form: SchemaOutput<typeof Attach>,
  ) {
    return { label: form.label, bytes: form.file.size };
  }
}

async function start(controller: new () => object) {
  @Module({ controllers: [controller] })
  class App {}
  const app = await VelaFactory.create(App, { globalPrefix: '/api' });
  return { app, App };
}

async function send(app: VelaApplication, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`https://example.test/api${path}`, {
      method,
      ...(body instanceof FormData
        ? { body }
        : body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
}

describe('defineRoute contracts', () => {
  it('validates params, query and body from the contract and sends its response', async () => {
    const { app } = await start(ContractTodos);
    try {
      const list = await send(app, 'GET', '/todos?tag=a&done=true');
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([{ id: 't1', title: 'tags:a', done: true }]);
      expect((await send(app, 'GET', '/todos?done=maybe')).status).toBe(400);

      const created = await send(app, 'POST', '/todos', { title: 'Ship' });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ id: 't2', title: 'Ship', done: false });
      expect((await send(app, 'POST', '/todos', { title: '' })).status).toBe(400);

      expect(await (await send(app, 'GET', '/todos/t7')).json()).toMatchObject({ id: 't7' });
      expect((await send(app, 'GET', '/todos/x7')).status).toBe(400);

      const removed = await send(app, 'DELETE', '/todos/t7');
      expect(removed.status).toBe(204);

      const form = new FormData();
      form.append('label', 'notes');
      form.append('file', new File(['abc'], 'notes.txt'));
      const attached = await send(app, 'POST', '/todos/t1/files', form);
      expect(attached.status).toBe(201);
      expect(await attached.json()).toEqual({ label: 'notes', bytes: 3 });
      const json = await send(app, 'POST', '/todos/t1/files', { label: 'x' });
      expect(json.status).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('validates each request group once for every parameter reading it', async () => {
    const { app } = await start(ContractTodos);
    try {
      validations = 0;
      const response = await send(app, 'PATCH', '/todos/abc', { title: 'Renamed' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'ABC', slug: 'ABC', title: 'Renamed' });
      expect(validations).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['without a global pipe', []],
    ['beside a global ValidationPipe', [new ValidationPipe()]],
    ['after a copying pipe and a global ValidationPipe', [new CopyPipe(), new ValidationPipe()]],
    ['after an in-place pipe and a global ValidationPipe', [new TouchPipe(), new ValidationPipe()]],
  ])('hands a contract-validated value to a schema-carrying class %s', async (_label, pipes) => {
    const { app } = await start(Stamps);
    app.useGlobalPipes(...pipes);
    try {
      const created = await send(app, 'POST', '/stamps', { at: 'noon' });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ at: 4 });
      const listed = await send(app, 'GET', '/stamps?page=2');
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ page: 2 });
      const read = await send(app, 'GET', '/stamps/7');
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ id: 7 });
      expect((await send(app, 'POST', '/stamps', { at: 1 })).status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('documents a contract exactly as the equivalent decorator options', async () => {
    const contract = await start(ContractTodos);
    const decorated = await start(DecoratedTodos);
    try {
      const fromContract = createOpenApiDocument(contract.App, { globalPrefix: '/api' });
      const fromDecorators = createOpenApiDocument(decorated.App, { globalPrefix: '/api' });
      delete fromContract.paths['/api/todos/{id}']!.patch;
      expect(fromContract).toEqual(fromDecorators);
      expect(fromContract.paths['/api/todos']!.post!.responses['201']).toMatchObject({
        content: { 'application/json': { schema: { type: 'object' } } },
      });
      expect(fromContract.paths['/api/todos/{id}']!.delete!.responses).toEqual({
        '204': { description: 'OK' },
      });
    } finally {
      await contract.app.close();
      await decorated.app.close();
    }
  });

  it('lists the form encodings of contracts for a client transport', () => {
    const signup = defineRoute({
      method: 'POST',
      path: '/api/signups',
      body: z.object({ email: z.string() }),
      form: {},
    });
    expect(contractFormEncodings({ ...routes, signup })).toEqual([
      { path: '/api/todos/:id/files', method: 'POST', contentType: 'multipart/form-data' },
      { path: '/api/signups', method: 'POST', contentType: 'application/x-www-form-urlencoded' },
    ]);
    expect(contractFormEncodings([routes.create, signup])).toEqual([
      { path: '/api/signups', method: 'POST', contentType: 'application/x-www-form-urlencoded' },
    ]);
    // A form contract without a path cannot be matched by a client.
    expect(() =>
      contractFormEncodings([defineRoute({ method: 'POST', body: z.object({}), form: {} })]),
    ).toThrow(/needs its path/);
  });

  it('rejects a contract served by another method or at another path', async () => {
    // @ts-expect-error a GET contract cannot be served by @Post
    expect(() => Post('/', routes.list)).toThrow(/GET cannot be served by @POST/);
    @Controller('/elsewhere')
    class Elsewhere {
      @Post(routes.create)
      create() {
        return { id: 'x', title: 'x', done: false };
      }
    }
    await expect(start(Elsewhere)).rejects.toThrow(/not its contract path \/api\/todos/);
    // The contract's status is what its clients are typed to expect.
    @Controller('/todos')
    class Recoded {
      @Post(routes.create)
      @HttpCode(200)
      create() {
        return { id: 'x', title: 'x', done: false };
      }
    }
    await expect(start(Recoded)).rejects.toThrow(/declare status in the defineRoute contract/);
    expect(() => defineRoute({ method: 'GET', path: 'todos' })).toThrow(/start with \//);
    expect(() => defineRoute({ method: 'GET', body: CreateTodo })).toThrow(/no request body/);
    expect(() => defineRoute({ method: 'POST', body: Attach, form: {}, multipart: {} })).toThrow(
      /one of json, form or multipart/,
    );
  });
});
