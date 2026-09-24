import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Controller, Get, Module, Query, VelaFactory, type VelaApplication } from '../index';
import { createOpenApiDocument } from '../openapi/index';
import type { SchemaOutput } from '../validation/index';

const Search = z.object({
  q: z.string(),
  tag: z.array(z.string()).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

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
  });
});
