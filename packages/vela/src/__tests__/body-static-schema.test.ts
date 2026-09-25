import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BadRequestException,
  Body,
  Controller,
  Module,
  Post,
  VelaFactory,
  type ArgumentMetadata,
  type PipeTransform,
  type VelaApplication,
} from '../index';
import { MetadataRegistry, ParamType } from '../module-kit';
import { createOpenApiDocument } from '../openapi/index';
import { defineDto, ValidationPipe, type StandardSchemaV1 } from '../validation/index';

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

// A named `@Body('item')` parameter whose class describes only that member.
class Item {
  static schema = z.object({ sku: z.string().regex(/^[A-Z]{3}$/) });
  declare sku: string;
}

class LooseItem {
  static schema = z.looseObject({ sku: z.string().regex(/^[A-Z]{3}$/) });
  declare sku: string;
}

class Note {
  static schema = z.object({ text: z.string().min(1) });
  declare text: string;
}

// A pipe returning a new value: every string of an object body, trimmed.
class TrimPipe implements PipeTransform {
  transform(value: unknown) {
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        typeof member === 'string' ? member.trim() : member,
      ]),
    );
  }
}

// A pipe returning the value it receives.
class PassPipe implements PipeTransform {
  transform(value: unknown) {
    return value;
  }
}

// A pipe changing the object it receives and returning that same object.
class TrimInPlacePipe implements PipeTransform {
  transform(value: unknown) {
    if (value === null || typeof value !== 'object') return value;
    for (const [key, member] of Object.entries(value))
      if (typeof member === 'string') Reflect.set(value, key, member.trim());
    return value;
  }
}

// Schemas whose transforms do not accept their own output.
class Event {
  static schema = z.object({
    title: z.string().min(1),
    at: z.iso.datetime().transform((at) => new Date(at)),
  });
  declare title: string;
  declare at: Date;
}

class Stamp {
  static schema = z.object({ at: z.string().transform((at) => at.length) });
  declare at: number;
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

  @Post('/named')
  named(@Body('item') item: Item) {
    return { item: item ?? null };
  }

  @Post('/loose')
  loose(@Body('item') item: LooseItem) {
    return { item: item ?? null };
  }

  @Post('/notes')
  note(@Body() body: Note) {
    return body;
  }

  @Post('/events')
  event(@Body() body: Event) {
    return { title: body.title, at: body.at instanceof Date ? body.at.toISOString() : body.at };
  }

  @Post('/stamps')
  stamp(@Body() body: Stamp) {
    return body;
  }

  @Post('/checked-notes')
  checkedNote(@Body(TrimInPlacePipe, ValidationPipe) body: Note) {
    return body;
  }

  @Post('/checked-events')
  checkedEvent(@Body(TrimPipe, ValidationPipe) body: Event) {
    return { title: body.title, at: body.at instanceof Date ? body.at.toISOString() : body.at };
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

  it('validates again a value an earlier pipe changed before the global ValidationPipe', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new TrimPipe(), new ValidationPipe());
    try {
      const blank = await post(app, '/notes', { text: '   ' });
      expect(blank.status).toBe(400);
      expect((await blank.json()).error.details.issues[0].path).toEqual(['text']);
      const trimmed = await post(app, '/notes', { text: ' hi ' });
      expect(trimmed.status).toBe(201);
      expect(await trimmed.json()).toEqual({ text: 'hi' });
    } finally {
      await app.close();
    }
  });

  it('validates a value an earlier pipe changed in place before the global ValidationPipe', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new TrimInPlacePipe(), new ValidationPipe());
    try {
      const blank = await post(app, '/notes', { text: '   ' });
      expect(blank.status).toBe(400);
      expect((await blank.json()).error.details.issues[0].path).toEqual(['text']);
      const trimmed = await post(app, '/notes', { text: ' hi ' });
      expect(trimmed.status).toBe(201);
      expect(await trimmed.json()).toEqual({ text: 'hi' });
    } finally {
      await app.close();
    }
  });

  it('validates the input once when a pipe copies it before the global ValidationPipe', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new TrimPipe(), new ValidationPipe());
    try {
      const event = await post(app, '/events', { title: ' Launch ', at: '2026-09-24T10:00:00Z' });
      expect(event.status).toBe(201);
      expect(await event.json()).toEqual({ title: 'Launch', at: '2026-09-24T10:00:00.000Z' });
      const stamp = await post(app, '/stamps', { at: ' abc ' });
      expect(stamp.status).toBe(201);
      expect(await stamp.json()).toEqual({ at: 3 });
    } finally {
      await app.close();
    }
  });

  it('validates as it reads the body, before the pipes, when no ValidationPipe applies', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new TrimInPlacePipe());
    try {
      expect((await post(app, '/notes', { text: '' })).status).toBe(400);
      // The schema saw the untrimmed text; the pipe trimmed the valid value.
      const blank = await post(app, '/notes', { text: '   ' });
      expect(blank.status).toBe(201);
      expect(await blank.json()).toEqual({ text: '' });
      transforms = 0;
      const created = await post(app, '', { title: ' Once ' });
      expect(await created.json()).toEqual({ title: 'Once' });
      expect(transforms).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('leaves the class to a ValidationPipe subclass, which validates once', async () => {
    class StrictPipe extends ValidationPipe {}
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new StrictPipe());
    try {
      const stamp = await post(app, '/stamps', { at: 'abc' });
      expect(stamp.status).toBe(201);
      expect(await stamp.json()).toEqual({ at: 3 });
      expect((await post(app, '/stamps', { at: 1 })).status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('leaves the class to a ValidationPipe a parameter pipe class resolves to', async () => {
    // A pipe class the module provides as a ValidationPipe.
    class BodyValidator implements PipeTransform {
      transform(value: unknown, _metadata: ArgumentMetadata): unknown {
        return value;
      }
    }
    @Controller('/resolved')
    class Resolved {
      @Post()
      stamp(@Body(BodyValidator) body: Stamp) {
        return body;
      }
    }
    @Module({
      controllers: [Resolved],
      providers: [{ provide: BodyValidator, useClass: ValidationPipe }],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.fetch(
        new Request('https://example.test/resolved', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: 'abc' }),
        }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ at: 3 });
    } finally {
      await app.close();
    }
  });

  it('runs a validation pipe that is not a ValidationPipe after the class validated the body', async () => {
    // A pipe parsing the class schema itself receives the validated value.
    class SchemaPipe implements PipeTransform {
      transform(value: unknown, metadata: ArgumentMetadata) {
        const schema: unknown =
          typeof metadata.metatype === 'function'
            ? Reflect.get(metadata.metatype, 'schema')
            : undefined;
        if (!(schema instanceof z.ZodType)) return value;
        const result = schema.safeParse(value);
        if (!result.success) throw new BadRequestException('Validation failed');
        return result.data;
      }
    }
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new SchemaPipe());
    try {
      // The class schema's transform does not accept its own output.
      const stamp = await post(app, '/stamps', { at: 'abc' });
      expect(stamp.status).toBe(400);
      const note = await post(app, '/notes', { text: 'hi' });
      expect(await note.json()).toEqual({ text: 'hi' });
    } finally {
      await app.close();
    }
  });

  it("validates at each ValidationPipe, as Nest does: a global one and the parameter's own", async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    try {
      // The parameter's own pipe receives the Date the global pipe produced.
      const event = await post(app, '/checked-events', {
        title: 'Launch',
        at: '2026-09-24T10:00:00Z',
      });
      expect(event.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("leaves the value to the parameter's own ValidationPipe, after its earlier pipes", async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const blank = await post(app, '/checked-notes', { text: '   ' });
      expect(blank.status).toBe(400);
      expect(await (await post(app, '/checked-notes', { text: ' hi ' })).json()).toEqual({
        text: 'hi',
      });
      const event = await post(app, '/checked-events', {
        title: ' Launch ',
        at: '2026-09-24T10:00:00Z',
      });
      expect(event.status).toBe(201);
      expect(await event.json()).toEqual({ title: 'Launch', at: '2026-09-24T10:00:00.000Z' });
    } finally {
      await app.close();
    }
  });

  it('validates once when the pipes before the global ValidationPipe keep the value', async () => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new PassPipe(), new ValidationPipe());
    try {
      transforms = 0;
      const created = await post(app, '', { title: ' Once ' });
      expect(await created.json()).toEqual({ title: 'Once' });
      expect(transforms).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['without a global pipe', false],
    ['beside a global ValidationPipe', true],
  ])('validates a named parameter against its member %s', async (_label, globalPipe) => {
    @Module({ controllers: [Todos] })
    class App {}
    const app = await VelaFactory.create(App);
    if (globalPipe) app.useGlobalPipes(new ValidationPipe());
    try {
      const valid = await post(app, '/named', { item: { sku: 'ABC' } });
      expect(valid.status).toBe(201);
      expect(await valid.json()).toEqual({ item: { sku: 'ABC' } });
      // The member is validated, not the body that carries it.
      expect((await post(app, '/named', { sku: 'ABC', item: { sku: 'bad' } })).status).toBe(400);
      const loose = await post(app, '/loose', {
        sku: 'ABC',
        item: { sku: 'not-valid', evil: true },
      });
      expect(loose.status).toBe(400);
      expect((await loose.json()).error.details.issues[0].path).toEqual(['sku']);
    } finally {
      await app.close();
    }
  });

  it('leaves a body parameter no route reader validated to the global ValidationPipe', async () => {
    // A programmatic route registers its body parameter without a reader.
    class CreateItem {
      static schema = z.object({ name: z.string().min(1), qty: z.number().int().positive() });
    }
    @Controller('/items')
    class Items {
      create(body: unknown) {
        return { body };
      }
    }
    Post()(Items.prototype, 'create', Object.getOwnPropertyDescriptor(Items.prototype, 'create')!);
    MetadataRegistry.addParameter(Items, 'create', {
      index: 0,
      type: ParamType.BODY,
      metatype: CreateItem,
    });
    @Module({ controllers: [Items] })
    class App {}
    const app = await VelaFactory.create(App);
    app.useGlobalPipes(new ValidationPipe());
    try {
      const rejected = await app.fetch(
        new Request('https://example.test/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '', qty: -5, admin: true }),
        }),
      );
      expect(rejected.status).toBe(400);
      const accepted = await app.fetch(
        new Request('https://example.test/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Bolt', qty: 2, admin: true }),
        }),
      );
      expect(await accepted.json()).toEqual({ body: { name: 'Bolt', qty: 2 } });
    } finally {
      await app.close();
    }
  });

  it('validates a static defineDto descriptor or parse() parser without a global pipe', async () => {
    // Static schemas ValidationPipe also reads from a parameter class.
    class Legacy {
      static schema = defineDto(z.object({ name: z.string() }).strict(), { name: 'Legacy' });
      declare name: string;
    }
    class Parsed {
      static schema = {
        parse(value: unknown) {
          const name = Reflect.get(Object(value), 'name');
          if (typeof name !== 'string')
            throw Object.assign(new Error('Invalid'), {
              issues: [{ message: 'name is required', path: ['name'] }],
            });
          return { name };
        },
      };
      declare name: string;
    }
    @Controller('/legacy')
    class LegacyController {
      @Post()
      legacy(@Body() body: Legacy) {
        return body;
      }

      @Post('/parsed')
      parsed(@Body() body: Parsed) {
        return body;
      }
    }
    @Module({ controllers: [LegacyController] })
    class App {}
    const app = await VelaFactory.create(App);
    const send = (path: string, body: unknown) =>
      app.fetch(
        new Request(`https://example.test/legacy${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    try {
      expect((await send('', { name: 5 })).status).toBe(400);
      expect((await send('', { name: 'Ada', isAdmin: true })).status).toBe(400);
      const created = await send('', { name: 'Ada' });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ name: 'Ada' });
      const invalid = await send('/parsed', { name: 5 });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.details.issues[0].path).toEqual(['name']);
      const parsed = await send('/parsed', { name: 'Ada', isAdmin: true });
      expect(parsed.status).toBe(201);
      expect(await parsed.json()).toEqual({ name: 'Ada' });
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
