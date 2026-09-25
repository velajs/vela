import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Controller,
  Injectable,
  Module,
  Post,
  RawBody,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type VelaApplication,
  type VelaBodyLimitOverride,
} from '../index';
import { createOpenApiDocument } from '../openapi/index';
import type { SchemaOutput } from '../validation/index';

const MiB = 1024 * 1024;
const KiB = 1024;

// A single-file upload with typed text fields: an enum, a uuid and a free-text
// description.
const Upload = z.object({
  kind: z.enum(['avatar', 'banner']),
  ownerId: z.uuid(),
  description: z.string().max(2000).optional(),
  file: z.file(),
});
const uploadLimits = {
  maxFileBytes: 25 * MiB,
  maxFiles: 1,
  maxFields: 10,
  maxFieldBytes: 16 * KiB,
} as const;
const Stored = z.object({
  kind: z.enum(['avatar', 'banner']),
  ownerId: z.string(),
  description: z.string().nullable(),
  name: z.string(),
  bytes: z.number(),
});

const Signup = z.object({
  email: z.email(),
  tags: z.array(z.string()).optional(),
  age: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
});

let transforms = 0;
const Counted = z.object({
  count: z.string().transform((value) => {
    transforms++;
    return Number(value);
  }),
});

@Injectable()
class Deny implements CanActivate {
  canActivate() {
    return false;
  }
}

@Controller('/uploads')
class Uploads {
  @Post({ response: Stored, body: { multipart: uploadLimits } })
  async upload(@Body(Upload) form: SchemaOutput<typeof Upload>) {
    expectTypeOf(form.kind).toEqualTypeOf<'avatar' | 'banner'>();
    expectTypeOf(form.file).toEqualTypeOf<File>();
    return {
      kind: form.kind,
      ownerId: form.ownerId,
      description: form.description ?? null,
      name: form.file.name,
      bytes: (await form.file.arrayBuffer()).byteLength,
    };
  }

  @Post('/denied', { body: { multipart: uploadLimits } })
  @UseGuards(Deny)
  denied(@Body(Upload) _form: SchemaOutput<typeof Upload>): never {
    throw new Error('unreachable');
  }

  @Post('/signup', { body: { form: { maxFields: 5 } } })
  signup(@Body(Signup) form: SchemaOutput<typeof Signup>) {
    return form;
  }

  @Post('/json', { body: { json: { maxBytes: 64 } } })
  json(@Body() body: unknown) {
    return { body };
  }

  @Post('/bytes', { body: { json: { maxBytes: 64 * KiB } } })
  bytes(@RawBody() bytes: Uint8Array) {
    return { bytes: bytes.byteLength };
  }

  @Post('/counted', { body: { form: {} } })
  counted(@Body('count') count: unknown, @Body(Counted) form: SchemaOutput<typeof Counted>) {
    return { count, form };
  }

  @Post('/raw', { body: { multipart: { maxFiles: 2 } } })
  raw(@Body() form: unknown) {
    const entries = Object.entries(Object(form)).map(([name, value]) => [
      name,
      value instanceof File ? `file:${value.name}` : value,
    ]);
    return Object.fromEntries(entries);
  }

  @Post('/explicit', { body: { multipart: { maxFileBytes: 4 * MiB, maxBytes: 5 * MiB } } })
  explicit(@Body('file', z.file()) file: File) {
    return { bytes: file.size };
  }

  @Post('/named', { body: { multipart: {} } })
  named(@Body('file', z.file()) file: File, @Body('title') title: unknown) {
    return { name: file.name, title };
  }
}

async function start(
  options: { maxBytes?: number; streamingOverrides?: VelaBodyLimitOverride[] } = {},
) {
  @Module({ controllers: [Uploads], providers: [Deny] })
  class App {}
  return {
    app: await VelaFactory.create(App, { security: { body: options } }),
    App,
  };
}

function upload(fields: Record<string, string>, file?: File): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (file) form.append('file', file);
  return form;
}

const owner = '2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f';

// A body of `size` bytes streamed in 16 KiB chunks, counting what was pulled:
// zeros, or a JSON document (spaces, then an empty string).
function streamed(size: number, json = false) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = new Uint8Array(Math.min(16 * KiB, size - pulled));
      pulled += chunk.byteLength;
      if (json) chunk.fill(0x20);
      if (json && pulled >= size) chunk.fill(0x22, -2);
      controller.enqueue(chunk);
      if (pulled >= size) controller.close();
    },
  });
  return { body, pulled: () => pulled };
}

async function post(app: VelaApplication, path: string, body: BodyInit, headers?: HeadersInit) {
  return app.fetch(
    new Request(`https://example.test/uploads${path}`, { method: 'POST', body, headers }),
  );
}

describe('per-route multipart bodies', () => {
  it('passes a valid upload to the handler as typed values', async () => {
    const { app } = await start();
    try {
      const bytes = new Uint8Array(3 * MiB).fill(7);
      const response = await post(
        app,
        '',
        upload(
          { kind: 'banner', ownerId: owner, description: 'A long free-text description' },
          new File([bytes], 'banner.png', { type: 'image/png' }),
        ),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        kind: 'banner',
        ownerId: owner,
        description: 'A long free-text description',
        name: 'banner.png',
        bytes: 3 * MiB,
      });
    } finally {
      await app.close();
    }
  });

  it('answers 413 for oversized files, bodies and field counts, and 400 for extra files or fields', async () => {
    const { app } = await start();
    try {
      const oversizedFile = new File([new Uint8Array(25 * MiB + 1)], 'big.bin');
      expect(
        (await post(app, '', upload({ kind: 'avatar', ownerId: owner }, oversizedFile))).status,
      ).toBe(413);

      const tooManyFields = upload({ kind: 'avatar', ownerId: owner });
      for (let index = 0; index < 9; index++) tooManyFields.append('description', 'x');
      tooManyFields.append('file', new File(['a'], 'a.txt'));
      expect((await post(app, '', tooManyFields)).status).toBe(413);

      const longField = upload({
        kind: 'avatar',
        ownerId: owner,
        description: 'x'.repeat(17 * KiB),
      });
      longField.append('file', new File(['a'], 'a.txt'));
      expect((await post(app, '', longField)).status).toBe(413);

      const twoFiles = upload({ kind: 'avatar', ownerId: owner }, new File(['a'], 'a.txt'));
      twoFiles.append('file', new File(['b'], 'b.txt'));
      expect((await post(app, '', twoFiles)).status).toBe(413);

      const unknownField = upload(
        { kind: 'avatar', ownerId: owner, extra: 'nope' },
        new File(['a'], 'a.txt'),
      );
      const unknown = await post(app, '', unknownField);
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({
        error: { message: 'Unknown form field: extra' },
      });

      const repeated = upload({ kind: 'avatar', ownerId: owner }, new File(['a'], 'a.txt'));
      repeated.append('kind', 'banner');
      expect((await post(app, '', repeated)).status).toBe(400);

      const invalid = await post(
        app,
        '',
        upload({ kind: 'poster', ownerId: 'not-a-uuid' }, new File(['a'], 'a.txt')),
      );
      expect(invalid.status).toBe(400);
      const body = await invalid.json();
      expect(
        body.error.details.issues.map((issue: { path: string[] }) => issue.path[0]).sort(),
      ).toEqual(['kind', 'ownerId']);
    } finally {
      await app.close();
    }
  });

  it('answers 415 for other media types, including JSON', async () => {
    const { app } = await start();
    try {
      for (const [contentType, raw] of [
        ['application/json', '{"kind":"avatar"}'],
        ['application/x-www-form-urlencoded', 'kind=avatar'],
        ['text/plain', 'kind=avatar'],
      ] as const) {
        const response = await post(app, '', raw, { 'content-type': contentType });
        expect({ contentType, status: response.status }).toEqual({ contentType, status: 415 });
        expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
      }
      const malformed = await post(app, '', 'bad', { 'content-type': 'multipart/form-data' });
      expect(malformed.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('runs guards before reading, measuring or parsing the body', async () => {
    const { app } = await start();
    try {
      for (const contentType of ['application/json', 'multipart/form-data; boundary=broken']) {
        const response = await post(app, '/denied', 'broken', { 'content-type': contentType });
        expect(response.status).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it("uses a route's own maxBytes instead of the application's limit", async () => {
    const { app } = await start({ maxBytes: 64 * KiB });
    try {
      const file = new FormData();
      file.append('file', new File([new Uint8Array(2 * MiB)], 'a.bin'));
      const response = await post(app, '/explicit', file);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ bytes: 2 * MiB });
      const json = await post(app, '/json', JSON.stringify({ text: 'x'.repeat(100) }), {
        'content-type': 'application/json',
      });
      expect(json.status).toBe(413);
    } finally {
      await app.close();
    }
  });

  it('keeps a configured application limit on routes that set no maxBytes', async () => {
    const { app } = await start({ maxBytes: 64 * KiB });
    try {
      // Encoded up front: Node cannot cancel a FormData body mid-stream cleanly.
      const encoded = new Response(
        upload({ kind: 'avatar', ownerId: owner }, new File([new Uint8Array(2 * MiB)], 'a.bin')),
      );
      const response = await post(app, '', await encoded.arrayBuffer(), {
        'content-type': encoded.headers.get('content-type')!,
      });
      expect(response.status).toBe(413);
    } finally {
      await app.close();
    }
    const strict = await start({ maxBytes: 1024 });
    try {
      const form = new URLSearchParams([
        ['email', `${'a'.repeat(2000)}@example.test`],
        ['age', '1'],
      ]);
      expect((await post(strict.app, '/signup', form)).status).toBe(413);
    } finally {
      await strict.app.close();
    }
  });

  it('streams a declared-length body without reading past the limit', async () => {
    const { app } = await start();
    try {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 64 * KiB;
          controller.enqueue(new Uint8Array(64 * KiB));
          if (pulled > 200 * MiB) controller.close();
        },
      });
      const response = await app.fetch(
        new Request('https://example.test/uploads', {
          method: 'POST',
          body: stream,
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect(pulled).toBeLessThan(27 * MiB);
    } finally {
      await app.close();
    }
  });

  it('runs guards before pulling a body sent without Content-Length', async () => {
    const { app } = await start();
    try {
      const sent = streamed(20 * MiB);
      const response = await app.fetch(
        new Request('https://example.test/uploads/denied', {
          method: 'POST',
          body: sent.body,
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(response.status).toBe(403);
      expect(sent.pulled()).toBeLessThan(MiB);
    } finally {
      await app.close();
    }
  });

  it('bounds every reader of a body sent without Content-Length at the route limit', async () => {
    const { app } = await start();
    try {
      const within = streamed(32 * KiB, true);
      const accepted = await app.fetch(
        new Request('https://example.test/uploads/bytes', {
          method: 'POST',
          body: within.body,
          headers: { 'content-type': 'application/json' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(accepted.status).toBe(201);
      expect(await accepted.json()).toEqual({ bytes: 32 * KiB });
      const beyond = streamed(20 * MiB, true);
      const rejected = await app.fetch(
        new Request('https://example.test/uploads/bytes', {
          method: 'POST',
          body: beyond.body,
          headers: { 'content-type': 'application/json' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(rejected.status).toBe(413);
      expect(beyond.pulled()).toBeLessThan(MiB);
    } finally {
      await app.close();
    }
  });

  it('counts a body sent without Content-Length at a matching streaming override, after guards', async () => {
    const { app } = await start({
      streamingOverrides: [
        { path: '/uploads/denied', methods: ['POST'], maxBytes: 30 * MiB },
        { path: '/uploads', methods: ['POST'], maxBytes: 64 * KiB },
      ],
    });
    try {
      const denied = streamed(20 * MiB);
      const forbidden = await app.fetch(
        new Request('https://example.test/uploads/denied', {
          method: 'POST',
          body: denied.body,
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(forbidden.status).toBe(403);
      expect(denied.pulled()).toBeLessThan(MiB);
      const beyond = streamed(20 * MiB);
      const rejected = await app.fetch(
        new Request('https://example.test/uploads', {
          method: 'POST',
          body: beyond.body,
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          duplex: 'half',
        } as RequestInit),
      );
      expect(rejected.status).toBe(413);
      expect(beyond.pulled()).toBeLessThan(MiB);
    } finally {
      await app.close();
    }
  });

  it('keeps an undeclared multipart body as named text and file entries', async () => {
    const { app } = await start();
    try {
      const form = new FormData();
      form.append('title', 'Doc');
      form.append('tag', 'a');
      form.append('tag', 'b');
      form.append('file', new File(['x'], 'x.txt'));
      const response = await post(app, '/raw', form);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ title: 'Doc', tag: ['a', 'b'], file: 'file:x.txt' });
    } finally {
      await app.close();
    }
  });
});

describe('named multipart members', () => {
  it('validates one member with its own schema and reads another from the same body', async () => {
    const { app } = await start();
    try {
      const form = new FormData();
      form.append('title', 'Doc');
      form.append('file', new File(['x'], 'x.txt'));
      const response = await post(app, '/named', form);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ name: 'x.txt', title: 'Doc' });
      const missing = new FormData();
      missing.append('title', 'Doc');
      expect((await post(app, '/named', missing)).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('per-route URL-encoded and JSON bodies', () => {
  it('parses a URL-encoded body with typed, repeated and transformed fields', async () => {
    const { app } = await start();
    try {
      const response = await post(
        app,
        '/signup',
        new URLSearchParams([
          ['email', 'ada@example.test'],
          ['tags', 'one'],
          ['age', '36'],
        ]),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ email: 'ada@example.test', tags: ['one'], age: 36 });
      const tooMany = new URLSearchParams([
        ['email', 'ada@example.test'],
        ['age', '1'],
      ]);
      for (let index = 0; index < 5; index++) tooMany.append('tags', String(index));
      expect((await post(app, '/signup', tooMany)).status).toBe(413);
      const json = await post(app, '/signup', '{}', { 'content-type': 'application/json' });
      expect(json.status).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('reads the body once for several parameters and runs a transform once', async () => {
    const { app } = await start();
    try {
      transforms = 0;
      const response = await post(app, '/counted', new URLSearchParams([['count', '3']]));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ count: '3', form: { count: 3 } });
      expect(transforms).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('bounds a JSON body and still requires a JSON media type', async () => {
    const { app } = await start();
    try {
      const small = await post(app, '/json', '{"ok":true}', { 'content-type': 'application/json' });
      expect(small.status).toBe(201);
      expect(await small.json()).toEqual({ body: { ok: true } });
      const large = await post(app, '/json', JSON.stringify({ text: 'x'.repeat(100) }), {
        'content-type': 'application/json',
      });
      expect(large.status).toBe(413);
      const text = await post(app, '/json', '{"ok":true}', { 'content-type': 'text/plain' });
      expect(text.status).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('documents each encoding, its fields and limits in OpenAPI', async () => {
    const { app, App } = await start();
    try {
      const document = createOpenApiDocument(App);
      const multipart = document.paths['/uploads']!.post!.requestBody!;
      expect(multipart.required).toBe(true);
      expect(multipart.content!['multipart/form-data']!.schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['avatar', 'banner'] },
          ownerId: { type: 'string', format: 'uuid' },
          file: { type: 'string', format: 'binary' },
        },
        required: ['kind', 'ownerId', 'file'],
      });
      expect(multipart.content!['multipart/form-data']!.encoding?.file).toEqual({
        style: 'form',
        explode: true,
      });
      expect(multipart['x-vela-body-limits']).toEqual({
        maxBytes: 26 * MiB,
        maxFields: 10,
        maxFieldBytes: 16 * KiB,
        maxFiles: 1,
        maxFileBytes: 25 * MiB,
      });
      expect(document.paths['/uploads']!.post!.responses['201']).toMatchObject({
        content: { 'application/json': { schema: { type: 'object' } } },
      });
      const form = document.paths['/uploads/signup']!.post!.requestBody!;
      expect(Object.keys(form.content!)).toEqual(['application/x-www-form-urlencoded']);
      expect(form['x-vela-body-limits']).toEqual({
        maxBytes: MiB,
        maxFields: 5,
        maxFieldBytes: 64 * KiB,
      });
      expect(document.paths['/uploads/json']!.post!.requestBody!['x-vela-body-limits']).toEqual({
        maxBytes: 64,
      });
    } finally {
      await app.close();
    }
  });

  it('rejects form schemas that cannot arrive as text or files when the application starts', async () => {
    @Controller('/bad')
    class Bad {
      @Post({ body: { form: {} } })
      create(@Body(z.object({ count: z.number() })) _form: unknown) {}
    }
    @Module({ controllers: [Bad] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(/form field count/);
    @Controller('/file')
    class FileInForm {
      @Post({ body: { form: {} } })
      create(@Body(z.object({ file: z.file() })) _form: unknown) {}
    }
    @Module({ controllers: [FileInForm] })
    class FileApp {}
    await expect(VelaFactory.create(FileApp)).rejects.toThrow(/multipart/);
  });
});
