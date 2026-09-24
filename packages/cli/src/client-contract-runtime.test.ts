import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Controller, Get, Module, Post, VelaFactory } from '@velajs/vela';
import { ApiResponse, Endpoint, createOpenApiDocument, defineEndpoint } from '@velajs/vela/openapi';
import { z } from 'zod/v4';
import { expect, it } from 'vitest';
import { generateClientContract } from './client-contract';

// Zod 3's bundled v4 entry exposes the exporter as a function.
function schema<Value>(value: z.ZodType<Value>) {
  return {
    parse: (input: unknown) => value.parse(input),
    toJSONSchema: () => z.toJSONSchema(value),
  };
}

it('runs generated hc calls through the actual schema-bound Vela endpoint pipeline', async () => {
  const read = defineEndpoint({
    input: schema(
      z.object({
        param: z.object({ id: z.string() }),
        query: z.object({ tag: z.array(z.string()) }),
        header: z.object({ 'x-team': z.string() }),
      }),
    ),
    output: schema(z.object({ id: z.string(), tags: z.array(z.string()), team: z.string() })),
  });
  const create = defineEndpoint({
    input: schema(z.object({ json: z.object({ name: z.string() }) })),
    output: schema(z.object({ id: z.string(), name: z.string() })),
    status: 201,
  });
  let transforms = 0;
  const uploadInput = z.object({
    form: z.object({
      title: z.string(),
      tags: z.array(z.string()),
      count: z.string().transform((value) => {
        transforms++;
        return Number(value);
      }),
      file: z.file(),
      files: z.array(z.file()).optional(),
    }),
  });
  const upload = defineEndpoint({
    input: uploadInput,
    output: z.object({
      title: z.string(),
      tags: z.array(z.string()),
      count: z.number(),
      names: z.array(z.string()),
      contents: z.array(z.string()),
    }),
    body: { contentType: 'multipart/form-data', maxFileBytes: 1024 },
    status: 201,
  });
  const encodedInput = z.object({
    form: z.object({ title: z.string(), tags: z.array(z.string()).optional() }).optional(),
  });
  const encoded = defineEndpoint({
    input: encodedInput,
    output: z.object({ title: z.string(), tags: z.array(z.string()) }),
    body: { contentType: 'application/x-www-form-urlencoded' },
  });
  @Controller('/users')
  class Users {
    @Get('/:id')
    @Endpoint(read)
    read(input: ReturnType<typeof read.input.parse>) {
      return { id: input.param.id, tags: input.query.tag, team: input.header['x-team'] };
    }
    @Post()
    @Endpoint(create)
    create(input: ReturnType<typeof create.input.parse>) {
      return { id: 'u1', name: input.json.name };
    }
    @Post('/upload')
    @ApiResponse(400, {
      description: 'Invalid input',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    })
    @Endpoint(upload)
    async upload(input: z.output<typeof uploadInput>) {
      const files = [input.form.file, ...(input.form.files ?? [])];
      return {
        title: input.form.title,
        tags: input.form.tags,
        count: input.form.count,
        names: files.map((file) => file.name),
        contents: await Promise.all(files.map((file) => file.text())),
      };
    }
    @Post('/encoded')
    @Endpoint(encoded)
    encoded(input: z.output<typeof encodedInput>) {
      return { title: input.form?.title ?? 'absent', tags: input.form?.tags ?? [] };
    }
  }
  @Module({ controllers: [Users] })
  class App {}
  const app = await VelaFactory.create(App, { globalPrefix: '/api' });
  const dir = mkdtempSync(join(process.cwd(), '.client-runtime-'));
  try {
    const generated = generateClientContract(createOpenApiDocument(App, { globalPrefix: '/api' }));
    expect(generated.warnings).toEqual([]);
    writeFileSync(join(dir, 'api.ts'), generated.source);
    writeFileSync(
      join(dir, 'consumer.ts'),
      `
      import { hc, withFormEncoding } from '@velajs/client/http';
      import { formEncodings } from './api.js';
      import type { AppType } from './api.js';
      export async function exercise(fetch: typeof globalThis.fetch) {
        const client = hc<AppType>('https://api.test', { fetch: withFormEncoding(formEncodings, fetch) });
        const response = await client.api.users[':id'].$get({ param: { id: 'u1' }, query: { tag: ['one', 'two'] }, header: { 'x-team': 'demo' } });
        const read = await response.json();
        const created = await client.api.users.$post({ json: { name: 'Ada' } });
        const status: 201 = created.status;
        const user = await created.json();
        user.name.toUpperCase();
        const uploaded = await client.api.users.upload.$post({ form: {
          title: 'Files', tags: ['one', 'two'], count: '3',
          file: new File(['a'], 'a.txt'), files: [new File(['b'], 'b.txt'), new Blob(['c'])],
        } });
        if (uploaded.status === 400) {
          const message: string = (await uploaded.json()).message;
          throw new Error(message);
        }
        const uploadStatus: 201 = uploaded.status;
        const result = await uploaded.json();
        const count: number = result.count;
        const names: string[] = result.names;
        const contents: string[] = result.contents;
        const encoded = await (await client.api.users.encoded.$post({ form: { title: 'é & +', tags: ['a+b', 'c d'] } })).json();
        const absent = await (await client.api.users.encoded.$post()).json();
        if (false) {
          // @ts-expect-error file fields must be files or blobs, never strings
          client.api.users.upload.$post({ form: { title: 'Files', tags: [], count: '1', file: 'text' } });
          // @ts-expect-error required file is missing
          client.api.users.upload.$post({ form: { title: 'Files', tags: [], count: '1' } });
          // @ts-expect-error transformed count is a string on the wire
          client.api.users.upload.$post({ form: { title: 'Files', tags: [], count: 1, file: new Blob() } });
          // @ts-expect-error repeated text fields do not accept a scalar
          client.api.users.encoded.$post({ form: { title: 'Files', tags: 'one' } });
        }
        return { read, user, status, uploadStatus, count, names, contents, encoded, absent };
      }
    `,
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          outDir: './out',
        },
        include: ['*.ts'],
      }),
    );
    const tsc = join(
      dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
      'bin/tsc',
    );
    try {
      execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    } catch (error) {
      throw new Error(String(error instanceof Error && 'stdout' in error ? error.stdout : error), {
        cause: error,
      });
    }
    const consumer: unknown = await import(
      /* @vite-ignore */ pathToFileURL(join(dir, 'out/consumer.js')).href
    );
    if (
      typeof consumer !== 'object' ||
      consumer === null ||
      !('exercise' in consumer) ||
      typeof consumer.exercise !== 'function'
    )
      throw new Error('Missing generated consumer');
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/encoded') && request.body)
        expect(request.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
      if (request.url.endsWith('/upload'))
        expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      return app.fetch(request);
    };
    expect(await consumer.exercise(fetch)).toEqual({
      read: { id: 'u1', tags: ['one', 'two'], team: 'demo' },
      user: { id: 'u1', name: 'Ada' },
      status: 201,
      uploadStatus: 201,
      count: 3,
      names: ['a.txt', 'b.txt', 'blob'],
      contents: ['a', 'b', 'c'],
      encoded: { title: 'é & +', tags: ['a+b', 'c d'] },
      absent: { title: 'absent', tags: [] },
    });
    expect(transforms).toBe(1);
  } finally {
    await app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
