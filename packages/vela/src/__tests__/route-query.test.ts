import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Get,
  Module,
  ParseArrayPipe,
  Query,
  VelaFactory,
  type VelaApplication,
} from '../index';
import { defineRoute, type ContractApp, type ContractQuery } from '../contract/index';
import { createOpenApiDocument } from '../openapi/index';
import { ValidationPipe, type SchemaOutput } from '../validation/index';

const Search = z.object({
  q: z.string(),
  tag: z.array(z.string()).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const Either = z.union([z.object({ q: z.string() }), z.object({ tag: z.array(z.string()) })]);

// A query class carrying its schema, validated by a global ValidationPipe.
class SearchDto {
  static schema = z.object({ q: z.string(), tag: z.array(z.string()).optional() });
  declare q: string;
  declare tag?: string[];
}

@Controller('/search')
class SearchController {
  @Get('/raw')
  raw(@Query() query: Record<string, string | string[]>) {
    return query;
  }

  @Get('/named')
  named(@Query('tag') tag: string | string[] | undefined) {
    return { tag: tag ?? null };
  }

  @Get('/declared')
  declared(@Query('tag', z.array(z.string())) tag: string[]) {
    return { tag };
  }

  @Get('/schema')
  schema(@Query(Search) query: SchemaOutput<typeof Search>) {
    return query;
  }

  @Get('/dto')
  dto(@Query() query: SearchDto) {
    return query;
  }

  @Get('/role')
  role(@Query('role') role: string) {
    return { role: role ?? null, admin: role === 'admin' };
  }

  @Get('/tags')
  tags(@Query('tags') tags: string[]) {
    return { tags: tags ?? null };
  }

  // An optional parameter keeps its declared type.
  @Get('/optional')
  optional(@Query('role') role?: string) {
    return { role: role ?? null };
  }

  // `string | undefined` is a union: repeated keys arrive as an array.
  @Get('/union')
  union(@Query('role') role: string | undefined) {
    return { role: role ?? null };
  }

  // A pipe that splits one value also receives repeated keys as an array.
  @Get('/split')
  split(@Query('ids', ParseArrayPipe) ids: string[]) {
    return { ids };
  }

  // A key one member of a union schema declares as an array.
  @Get('/either')
  either(@Query(Either) query: SchemaOutput<typeof Either>) {
    return query;
  }
}

@Module({ controllers: [SearchController] })
class App {}

async function get(app: VelaApplication, path: string) {
  return app.fetch(new Request(`https://example.test/search${path}`));
}

describe('array-aware @Query', () => {
  it('parses repeated keys to arrays and keeps single keys as strings', async () => {
    const app = await VelaFactory.create(App);
    try {
      expect(await (await get(app, '/raw?tag=a&tag=b&q=x')).json()).toEqual({
        tag: ['a', 'b'],
        q: 'x',
      });
      expect(await (await get(app, '/named?tag=a&tag=b')).json()).toEqual({ tag: ['a', 'b'] });
      expect(await (await get(app, '/named?tag=a')).json()).toEqual({ tag: 'a' });
      expect(await (await get(app, '/named')).json()).toEqual({ tag: null });
    } finally {
      await app.close();
    }
  });

  it('parses keys the schema declares as arrays to arrays, even when sent once', async () => {
    const app = await VelaFactory.create(App);
    try {
      expect(await (await get(app, '/declared?tag=only')).json()).toEqual({ tag: ['only'] });
      expect(await (await get(app, '/schema?q=vela&tag=one&page=2')).json()).toEqual({
        q: 'vela',
        tag: ['one'],
        page: 2,
      });
      expect(await (await get(app, '/schema?q=vela&tag=one&tag=two')).json()).toEqual({
        q: 'vela',
        tag: ['one', 'two'],
      });
    } finally {
      await app.close();
    }
  });

  it('reads array keys from a query class schema a global pipe validates', async () => {
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    try {
      const one = await get(app, '/dto?q=x&tag=one');
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ q: 'x', tag: ['one'] });
      expect(await (await get(app, '/dto?q=x&tag=one&tag=two')).json()).toEqual({
        q: 'x',
        tag: ['one', 'two'],
      });
    } finally {
      await app.close();
    }
  });

  it('gives an unvalidated named parameter the shape its declared type names', async () => {
    const app = await VelaFactory.create(App);
    try {
      // A string parameter reads the first value, as its type says.
      expect(await (await get(app, '/role?role=user&role=admin')).json()).toEqual({
        role: 'user',
        admin: false,
      });
      expect(await (await get(app, '/role?role=admin')).json()).toEqual({
        role: 'admin',
        admin: true,
      });
      expect(await (await get(app, '/optional?role=user&role=admin')).json()).toEqual({
        role: 'user',
      });
      expect(await (await get(app, '/union?role=user&role=admin')).json()).toEqual({
        role: ['user', 'admin'],
      });
      expect(await (await get(app, '/union?role=user')).json()).toEqual({ role: 'user' });
      // An array parameter is an array even when sent once.
      expect(await (await get(app, '/tags?tags=a')).json()).toEqual({ tags: ['a'] });
      expect(await (await get(app, '/tags?tags=a&tags=b')).json()).toEqual({ tags: ['a', 'b'] });
      expect(await (await get(app, '/tags')).json()).toEqual({ tags: null });
    } finally {
      await app.close();
    }
  });

  it('rejects a repeated scalar instead of choosing one value', async () => {
    const app = await VelaFactory.create(App);
    try {
      const response = await get(app, '/schema?q=a&q=b');
      expect(response.status).toBe(400);
      expect((await response.json()).error.details.issues[0].path).toEqual(['q']);
    } finally {
      await app.close();
    }
  });

  it('documents array query parameters as repeated keys', () => {
    const document = createOpenApiDocument(App);
    const declared = document.paths['/search/declared']!.get!.parameters!;
    expect(declared).toEqual([
      {
        name: 'tag',
        in: 'query',
        required: true,
        schema: { type: 'array', items: { type: 'string' } },
        style: 'form',
        explode: true,
      },
    ]);
    const schema = document.paths['/search/schema']!.get!.parameters!;
    expect(schema.find((parameter) => parameter.name === 'tag')).toMatchObject({
      required: false,
      style: 'form',
      explode: true,
    });
    expect(schema.find((parameter) => parameter.name === 'q')).toEqual({
      name: 'q',
      in: 'query',
      required: true,
      schema: { type: 'string' },
    });
    expect(document.paths['/search/tags']!.get!.parameters).toEqual([
      {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'array', items: { type: 'string' } },
        style: 'form',
        explode: true,
      },
    ]);
    expect(document.paths['/search/role']!.get!.parameters).toEqual([
      { name: 'role', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(document.paths['/search/optional']!.get!.parameters).toEqual([
      { name: 'role', in: 'query', required: false, schema: { type: 'string' } },
    ]);
  });

  it('reads a key any member of a union schema declares as an array as an array', async () => {
    const app = await VelaFactory.create(App);
    try {
      const one = await get(app, '/either?tag=x');
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ tag: ['x'] });
      expect(await (await get(app, '/either?q=x')).json()).toEqual({ q: 'x' });
    } finally {
      await app.close();
    }
  });

  it('documents a piped array parameter as one value or repeated keys, as it receives them', async () => {
    const app = await VelaFactory.create(App);
    try {
      expect(await (await get(app, '/split?ids=1&ids=2')).json()).toEqual({ ids: ['1', '2'] });
      expect(await (await get(app, '/split?ids=1,2')).json()).toEqual({ ids: ['1', '2'] });
    } finally {
      await app.close();
    }
    expect(createOpenApiDocument(App).paths['/search/split']!.get!.parameters).toEqual([
      {
        name: 'ids',
        in: 'query',
        required: false,
        schema: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        style: 'form',
        explode: true,
      },
    ]);
  });

  it('documents a union or unknown parameter as one value or repeated keys', () => {
    const document = createOpenApiDocument(App);
    const oneOrMany = {
      in: 'query',
      required: false,
      schema: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      style: 'form',
      explode: true,
    };
    expect(document.paths['/search/union']!.get!.parameters).toEqual([
      { name: 'role', ...oneOrMany },
    ]);
    expect(document.paths['/search/named']!.get!.parameters).toEqual([
      { name: 'tag', ...oneOrMany },
    ]);
  });
});

// A list filter with a field JSON Schema cannot express beside an array field.
const Since = z.object({
  since: z.coerce.date().optional(),
  tags: z.array(z.string()).optional(),
});
const Checked = z.object({
  cursor: z.custom<string>((value) => typeof value === 'string').optional(),
  tags: z.array(z.string()).optional(),
});

// The same filter on a query class, validated by a global ValidationPipe.
class SinceDto {
  static schema = Since;
  declare since?: Date;
  declare tags?: string[];
}

const listEvents = defineRoute({
  method: 'GET',
  path: '/events',
  query: Since,
  response: z.object({ since: z.string().nullable(), tags: z.array(z.string()) }),
});

const shown = (query: SchemaOutput<typeof Since>) => ({
  since: query.since?.toISOString() ?? null,
  tags: query.tags ?? [],
});

@Controller('/events')
class EventsController {
  @Get(listEvents)
  list(@Query() query: ContractQuery<typeof listEvents>) {
    return shown(query);
  }

  @Get('/schema')
  schema(@Query(Since) query: SchemaOutput<typeof Since>) {
    return shown(query);
  }

  @Get('/checked')
  checked(@Query(Checked) query: SchemaOutput<typeof Checked>) {
    return { tags: query.tags ?? [] };
  }

  @Get('/dto')
  dto(@Query() query: SinceDto) {
    return shown(query);
  }

  @Get('/days')
  days(@Query('days', z.array(z.coerce.date())) days: Date[]) {
    return { days: days.map((day) => day.toISOString()) };
  }
}

@Module({ controllers: [EventsController] })
class EventsApp {}

describe('array keys beside fields JSON Schema cannot express', () => {
  it('keeps a key the schema declares as an array an array when sent once', async () => {
    const app = await VelaFactory.create(EventsApp);
    app.useGlobalPipes(new ValidationPipe());
    try {
      const events = (path: string) => app.fetch(new Request(`https://example.test/events${path}`));
      for (const path of ['?tags=a', '/schema?tags=a', '/dto?tags=a']) {
        const response = await events(path);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ since: null, tags: ['a'] });
      }
      const dated = await events('/schema?since=2026-01-02&tags=a');
      expect(await dated.json()).toEqual({ since: '2026-01-02T00:00:00.000Z', tags: ['a'] });
      expect(await (await events('/checked?cursor=c1&tags=a')).json()).toEqual({ tags: ['a'] });
      expect(await (await events('/days?days=2026-01-02')).json()).toEqual({
        days: ['2026-01-02T00:00:00.000Z'],
      });
    } finally {
      await app.close();
    }
  });

  it('answers the query a typed contract client sends with one array element', async () => {
    const app = await VelaFactory.create(EventsApp);
    try {
      const client = hc<ContractApp<[typeof listEvents]>>('https://example.test', {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          app.fetch(new Request(input, init)),
      });
      const listed = await client.events.$get({ query: { tags: ['a'] } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ since: null, tags: ['a'] });
    } finally {
      await app.close();
    }
  });
});
