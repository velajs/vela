import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  Injectable,
  Module,
  Post,
  UseGuards,
  VelaFactory,
  type CanActivate,
} from '../index';
import {
  Endpoint,
  createOpenApiDocument,
  defineEndpoint,
  type EndpointBodyOptions,
} from '../openapi/index';
import { ValidationPipe, defineDto, type SchemaOutput } from '../validation/index';

const output = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  files: z.array(z.string()),
  count: z.number(),
  note: z.string().optional(),
});

async function createApp(body: EndpointBodyOptions = { contentType: 'multipart/form-data' }) {
  let transforms = 0;
  const input = defineDto(
    z.object({
      form: z.object({
        name: z.string(),
        tags: z.array(z.string()),
        count: z
          .string()
          .regex(/^\d+$/)
          .transform(async (value) => {
            transforms++;
            return Number(value);
          }),
        note: z.string().optional(),
        file: z.file().optional(),
        files: z.array(z.file()).optional(),
      }),
    }),
  );
  const definition = defineEndpoint({ input, output, body, status: 201 });
  @Injectable()
  class Deny implements CanActivate {
    canActivate() {
      return false;
    }
  }
  @Controller('/forms')
  class Forms {
    @Post()
    @Endpoint(definition)
    async create(value: SchemaOutput<typeof input>) {
      expectTypeOf(value.form.count).toEqualTypeOf<number>();
      expectTypeOf(value.form.files).toEqualTypeOf<File[] | undefined>();
      return {
        ...value.form,
        files: await Promise.all(
          [...(value.form.file ? [value.form.file] : []), ...(value.form.files ?? [])].map(
            async (file) => `${file.name}:${await file.text()}`,
          ),
        ),
      };
    }
    @Post('/denied')
    @UseGuards(Deny)
    @Endpoint(definition)
    denied(_value: SchemaOutput<typeof input>): never {
      throw new Error('unreachable');
    }
  }
  @Module({ controllers: [Forms], providers: [Deny] })
  class App {}
  const app = await VelaFactory.create(App);
  app.useGlobalPipes(new ValidationPipe());
  return { app, definition, document: createOpenApiDocument(App), transforms: () => transforms };
}

function form() {
  const value = new FormData();
  value.append('name', 'Ada');
  value.append('tags', 'one');
  value.append('tags', 'two');
  value.append('count', '2');
  return value;
}

describe('endpoint form contracts', () => {
  it('round trips text, files, repeated files and async transforms exactly once', async () => {
    const { app, transforms, document } = await createApp();
    try {
      const body = form();
      body.append('file', new File(['a'], 'a.txt', { type: 'text/plain' }));
      body.append('files', new File(['b'], 'b.txt'));
      body.append('files', new Blob(['c']), 'c.txt');
      const response = await app.fetch(
        new Request('https://example.test/forms', { method: 'POST', body }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        name: 'Ada',
        tags: ['one', 'two'],
        count: 2,
        files: ['a.txt:a', 'b.txt:b', 'c.txt:c'],
      });
      expect(transforms()).toBe(1);
      const contract = document.paths['/forms']!.post!.requestBody!;
      expect(contract.required).toBe(true);
      expect(contract.content!['multipart/form-data']!.schema).toMatchObject({
        additionalProperties: false,
        properties: {
          file: { type: 'string', format: 'binary' },
          count: { type: 'string' },
          files: { type: 'array', items: { format: 'binary' } },
        },
        required: ['name', 'tags', 'count'],
      });
      expect(contract.content!['multipart/form-data']!.encoding?.files).toEqual({
        style: 'form',
        explode: true,
      });
      expect(contract['x-vela-body-limits']?.maxBytes).toBe(1024 * 1024);
    } finally {
      await app.close();
    }
  });

  it('keeps single repeated fields as arrays, optional fields absent, and concurrent requests isolated', async () => {
    const { app } = await createApp();
    try {
      const results = await Promise.all(
        ['Ada', 'Lin'].map(async (name) => {
          const body = form();
          body.set('name', name);
          body.set('tags', name);
          body.append('files', new File([name], `${name}.txt`));
          const response = await app.fetch(
            new Request('https://example.test/forms', { method: 'POST', body }),
          );
          return response.json();
        }),
      );
      expect(results).toEqual(
        ['Ada', 'Lin'].map((name) => ({
          name,
          count: 2,
          tags: [name],
          files: [`${name}.txt:${name}`],
        })),
      );
    } finally {
      await app.close();
    }
  });

  it('runs guards before media checks, malformed parsing and schema transforms', async () => {
    const { app, transforms } = await createApp();
    try {
      for (const contentType of ['application/json', 'multipart/form-data; boundary=broken']) {
        const response = await app.fetch(
          new Request('https://example.test/forms/denied', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: 'broken',
          }),
        );
        expect(response.status).toBe(403);
      }
      expect(transforms()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects wrong media, missing boundaries, incomplete parts and missing required fields', async () => {
    const { app } = await createApp();
    try {
      for (const [contentType, raw, status] of [
        ['application/json', '{}', 415],
        ['application/x-www-form-urlencoded', 'name=Ada', 415],
        ['multipart/form-data', 'bad', 400],
        [
          'multipart/form-data; boundary=x',
          '--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nbad',
          400,
        ],
      ] as const) {
        const response = await app.fetch(
          new Request('https://example.test/forms', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: raw,
          }),
        );
        expect(response.status).toBe(status);
      }
      const response = await app.fetch(
        new Request('https://example.test/forms', { method: 'POST', body: new FormData() }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ message: 'Endpoint input validation failed' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['duplicate scalar', (value: FormData) => value.append('name', 'Lin')],
    ['text for file', (value: FormData) => value.append('file', 'no-file')],
    ['file for text', (value: FormData) => value.append('note', new File(['x'], 'x.txt'))],
    ['unknown field', (value: FormData) => value.append('__proto__', 'x')],
  ])('rejects %s without silently changing input', async (_name, alter) => {
    const { app, transforms } = await createApp();
    try {
      const body = form();
      alter(body);
      expect(
        (await app.fetch(new Request('https://example.test/forms', { method: 'POST', body })))
          .status,
      ).toBe(400);
      expect(transforms()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    [{ maxBytes: 16 }, (_value: FormData) => {}],
    [{ maxFields: 3 }, (_value: FormData) => {}],
    [{ maxFieldBytes: 5 }, (value: FormData) => value.set('name', 'éé')],
    [
      { maxFiles: 1 },
      (value: FormData) => {
        value.append('files', new File(['a'], 'a'));
        value.append('files', new File(['b'], 'b'));
      },
    ],
    [{ maxFileBytes: 2 }, (value: FormData) => value.append('file', new File(['abc'], 'x'))],
  ])('enforces bounded form limits %o', async (limits, alter) => {
    const { app, transforms } = await createApp({ contentType: 'multipart/form-data', ...limits });
    try {
      const body = form();
      alter(body);
      const response = await app.fetch(
        new Request('https://example.test/forms', { method: 'POST', body }),
      );
      expect(response.status).toBe(413);
      expect(transforms()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('supports URL-encoded optional bodies and literal keys without nested decoding', async () => {
    const input = z.object({
      form: z
        .object({
          'tag[]': z.array(z.string()),
          __proto__: z.string().optional(),
          count: z.string().transform(Number),
        })
        .optional(),
    });
    const definition = defineEndpoint({
      input,
      output: z.object({ tags: z.array(z.string()), count: z.number() }),
      body: { contentType: 'application/x-www-form-urlencoded' },
    });
    @Controller('/encoded')
    class Encoded {
      @Post()
      @Endpoint(definition)
      create(value: z.output<typeof input>) {
        return { tags: value.form?.['tag[]'] ?? [], count: value.form?.count ?? 0 };
      }
    }
    @Module({ controllers: [Encoded] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(createOpenApiDocument(App).paths['/encoded']!.post!.requestBody!.required).toBe(false);
      for (const body of [
        undefined,
        new URLSearchParams([
          ['tag[]', 'a+b'],
          ['tag[]', 'é & ='],
          ['count', '7'],
        ]),
      ]) {
        const response = await app.fetch(
          new Request('https://example.test/encoded', { method: 'POST', body }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(
          body ? { tags: ['a+b', 'é & ='], count: 7 } : { tags: [], count: 0 },
        );
      }
    } finally {
      await app.close();
    }
  });

  it('allows an explicit JSON byte limit and still requires a JSON media type', async () => {
    const definition = defineEndpoint({
      input: z.object({ json: z.string() }),
      output: z.string(),
      body: { contentType: 'application/json', maxBytes: 8 },
    });
    @Controller('/json')
    class Json {
      @Post()
      @Endpoint(definition)
      create(value: { json: string }) {
        return value.json;
      }
    }
    @Module({ controllers: [Json] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      for (const [body, contentType, status] of [
        ['"ok"', 'application/json', 200],
        ['"1234567"', 'application/json', 413],
        ['broken', 'application/json', 400],
        ['"ok"', 'text/plain', 415],
      ] as const) {
        const request = new Request('https://example.test/json', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
        expect((await app.fetch(request)).status).toBe(status);
      }
    } finally {
      await app.close();
    }
  });

  it('counts actual streamed bytes despite a short Content-Length and cancels at the limit', async () => {
    const definition = defineEndpoint({
      input: z.object({ form: z.object({ name: z.string() }) }),
      output: z.string(),
      body: { contentType: 'application/x-www-form-urlencoded', maxBytes: 5 },
    });
    @Controller('/stream')
    class Stream {
      @Post()
      @Endpoint(definition)
      create(value: { form: { name: string } }) {
        return value.form.name;
      }
    }
    @Module({ controllers: [Stream] })
    class App {}
    const app = await VelaFactory.create(App);
    let reads = 0;
    let cancelled = false;
    try {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new TextEncoder().encode('aaaa'));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'POST',
        body,
        duplex: 'half',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '1' },
      };
      const response = await app.fetch(new Request('https://example.test/stream', init));
      expect(response.status).toBe(413);
      expect(reads).toBe(2);
      expect(cancelled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('validates declarations before accepting requests', () => {
    const form = z.object({ form: z.object({ name: z.string() }) });
    expect(() => defineEndpoint({ input: form, output })).toThrow('explicit');
    expect(() =>
      defineEndpoint({
        input: z.object({ form: z.object({ file: z.file() }) }),
        output,
        body: { contentType: 'application/x-www-form-urlencoded' },
      }),
    ).toThrow('multipart');
    expect(() =>
      defineEndpoint({
        input: z.object({ form: z.object({ value: z.number() }) }),
        output,
        body: { contentType: 'multipart/form-data' },
      }),
    ).toThrow('wire strings');
    expect(() =>
      defineEndpoint({
        input: z.object({ form: z.object({ value: z.union([z.string(), z.file()]) }) }),
        output,
        body: { contentType: 'multipart/form-data' },
      }),
    ).toThrow('concrete');
    expect(() =>
      defineEndpoint({
        input: z.object({ json: z.string(), form: z.object({}) }),
        output,
        body: { contentType: 'multipart/form-data' },
      }),
    ).toThrow('combine');
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5])
      expect(() =>
        defineEndpoint({
          input: form,
          output,
          body: { contentType: 'multipart/form-data', maxBytes },
        }),
      ).toThrow('positive safe integer');
  });
});
