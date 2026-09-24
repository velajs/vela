import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Body, Controller, Module, Post, VelaFactory, type VelaApplication } from '../index';
import { createOpenApiDocument } from '../openapi/index';
import { ValidationPipe, type StandardSchemaV1 } from '../validation/index';

let transforms = 0;

// A parameter class carrying its schema: the metatype `@Body()` validates.
class CreateTodo {
  static schema = z.object({
    title: z
      .string()
      .min(1)
      .transform((title) => {
        transforms++;
        return title.trim();
      }),
  });
  declare title: string;
}

// A class that is itself a Standard Schema.
class Rename {
  static readonly '~standard': StandardSchemaV1.Props<unknown, { name: string }> = {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      const name =
        typeof value === 'object' && value !== null && 'name' in value ? value.name : undefined;
      return typeof name === 'string' && name.length > 0
        ? { value: { name } }
        : { issues: [{ message: 'name is required', path: ['name'] }] };
    },
  };
  declare name: string;
}

class Plain {
  declare anything: unknown;
}

@Controller('/todos')
class Todos {
  @Post()
  create(@Body() body: CreateTodo) {
    return body;
  }

  @Post('/rename')
  rename(@Body() body: Rename) {
    return body;
  }

  @Post('/plain')
  plain(@Body() body: Plain) {
    return body;
  }
}

async function post(app: VelaApplication, path: string, body: unknown) {
  return app.fetch(
    new Request(`https://example.test/todos${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('@Body() with a schema-carrying parameter class', () => {
  it('validates against the static Standard Schema without a global pipe', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      transforms = 0;
      const created = await post(app, '', { title: '  Ship  ', extra: true });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ title: 'Ship' });
      expect(transforms).toBe(1);
      const invalid = await post(app, '', { title: '' });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.details.issues[0].path).toEqual(['title']);
      expect((await post(app, '/rename', { name: 'Ada' })).status).toBe(201);
      const rename = await post(app, '/rename', {});
      expect(rename.status).toBe(400);
      expect(await (await post(app, '/plain', { anything: 1 })).json()).toEqual({ anything: 1 });
    } finally {
      await app.close();
    }
  });

  it('validates once beside a global ValidationPipe', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    try {
      transforms = 0;
      const created = await post(app, '', { title: ' Once ' });
      expect(await created.json()).toEqual({ title: 'Once' });
      expect(transforms).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('documents the static schema as the request body', () => {
    @Module({ controllers: [Todos] })
    class App {}
    const document = createOpenApiDocument(App);
    const body = document.paths['/todos']!.post!.requestBody!;
    expect(body.content!['application/json']!.schema).toEqual({
      $ref: '#/components/schemas/CreateTodo',
    });
    expect(document.components?.schemas?.CreateTodo).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string', minLength: 1 } },
    });
  });
});
