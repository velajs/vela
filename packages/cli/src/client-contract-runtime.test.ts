import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Body,
  Controller,
  Get,
  Headers,
  Module,
  Param,
  Post,
  Query,
  VelaFactory,
  type Type,
} from '@velajs/vela';
import { defineRoute, type ContractBody, type ContractQuery } from '@velajs/vela/contract';
import { ApiResponse, createOpenApiDocument } from '@velajs/vela/openapi';
import type { SchemaOutput } from '@velajs/vela/validation';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { generateClientContract } from './client-contract';

const User = z.object({ id: z.string(), tags: z.array(z.string()), team: z.string() });
const CreateUser = z.object({ name: z.string() });
const Created = z.object({ id: z.string(), name: z.string() });
const Problem = z.object({ message: z.string() });
let transforms = 0;
const Upload = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  count: z.string().transform((value) => {
    transforms++;
    return Number(value);
  }),
  file: z.file(),
  files: z.array(z.file()).optional(),
});
const Uploaded = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  count: z.number(),
  names: z.array(z.string()),
  contents: z.array(z.string()),
});
const Encoded = z.object({ title: z.string(), tags: z.array(z.string()).optional() }).optional();
const EncodedResult = z.object({ title: z.string(), tags: z.array(z.string()) });
const uploadLimits = { maxFileBytes: 1024, maxFiles: 3 };

async function describeUpload(form: SchemaOutput<typeof Upload>) {
  const files = [form.file, ...(form.files ?? [])];
  return {
    title: form.title,
    tags: form.tags,
    count: form.count,
    names: files.map((file) => file.name),
    contents: await Promise.all(files.map((file) => file.text())),
  };
}

// Decorator options with schema arguments.
@Controller('/users')
class DecoratedUsers {
  @Get('/:id', { response: User })
  read(
    @Param('id') id: string,
    @Query('tag', z.array(z.string())) tags: string[],
    @Headers('x-team', z.string()) team: string,
  ) {
    return { id, tags, team, internal: true };
  }
  @Post({ response: Created })
  create(@Body(CreateUser) body: SchemaOutput<typeof CreateUser>) {
    return { id: 'u1', name: body.name };
  }
  @Post('/upload', { response: Uploaded, body: { multipart: uploadLimits } })
  @ApiResponse({ status: 400, description: 'Invalid input', schema: Problem })
  upload(@Body(Upload) form: SchemaOutput<typeof Upload>) {
    return describeUpload(form);
  }
  @Post('/encoded', { response: EncodedResult, body: { form: {} } })
  encoded(@Body(Encoded) form: SchemaOutput<typeof Encoded>) {
    return { title: form?.title ?? 'absent', tags: form?.tags ?? [] };
  }
}

// The same routes as shared, browser-safe contracts.
const routes = {
  read: defineRoute({
    method: 'GET',
    path: '/api/users/:id',
    query: z.object({ tag: z.array(z.string()) }),
    response: User,
  }),
  create: defineRoute({ method: 'POST', path: '/api/users', body: CreateUser, response: Created }),
  upload: defineRoute({
    method: 'POST',
    path: '/api/users/upload',
    body: Upload,
    multipart: uploadLimits,
    response: Uploaded,
  }),
  encoded: defineRoute({
    method: 'POST',
    path: '/api/users/encoded',
    body: Encoded,
    form: {},
    response: EncodedResult,
  }),
};

@Controller('/users')
class ContractUsers {
  @Get('/:id', routes.read)
  read(
    @Param('id') id: string,
    @Query() query: ContractQuery<typeof routes.read>,
    @Headers('x-team', z.string()) team: string,
  ) {
    return { id, tags: query.tag, team };
  }
  @Post(routes.create)
  create(@Body() body: ContractBody<typeof routes.create>) {
    return { id: 'u1', name: body.name };
  }
  @Post('/upload', routes.upload)
  @ApiResponse({ status: 400, description: 'Invalid input', schema: Problem })
  upload(@Body() form: ContractBody<typeof routes.upload>) {
    return describeUpload(form);
  }
  @Post('/encoded', routes.encoded)
  encoded(@Body() form: ContractBody<typeof routes.encoded>) {
    return { title: form?.title ?? 'absent', tags: form?.tags ?? [] };
  }
}

function moduleFor(controller: Type) {
  @Module({ controllers: [controller] })
  class App {}
  return App;
}

const consumerSource = `
  import { hc, withFormEncoding } from '@velajs/client/http';
  import { formEncodings } from './api.js';
  import type { AppType } from './api.js';
  export async function exercise(fetch: typeof globalThis.fetch) {
    const client = hc<AppType>('https://api.test', { fetch: withFormEncoding(formEncodings, fetch) });
    const response = await client.api.users[':id'].$get({ param: { id: 'u1' }, query: { tag: ['one', 'two'] }, header: { 'x-team': 'demo' } });
    const read = await response.json();
    const team: string = read.team;
    const single = await (await client.api.users[':id'].$get({ param: { id: 'u2' }, query: { tag: ['only'] }, header: { 'x-team': team } })).json();
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
      // @ts-expect-error the response schema declares no \`internal\` field
      read.internal;
    }
    return { read, single, user, status, uploadStatus, count, names, contents, encoded, absent };
  }
`;

it('generates one client for decorator options and defineRoute contracts, and runs it through each', async () => {
  const decorated = moduleFor(DecoratedUsers);
  const contracted = moduleFor(ContractUsers);
  const fromDecorators = generateClientContract(
    createOpenApiDocument(decorated, { globalPrefix: '/api' }),
  );
  const fromContracts = generateClientContract(
    createOpenApiDocument(contracted, { globalPrefix: '/api' }),
  );
  expect(fromDecorators.warnings).toEqual([]);
  expect(fromContracts.source).toBe(fromDecorators.source);

  const dir = mkdtempSync(join(process.cwd(), '.client-runtime-'));
  try {
    writeFileSync(join(dir, 'api.ts'), fromDecorators.source);
    writeFileSync(join(dir, 'consumer.ts'), consumerSource);
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
    const exercise = consumer.exercise;
    for (const module of [decorated, contracted]) {
      const app = await VelaFactory.create(module, { globalPrefix: '/api' });
      try {
        transforms = 0;
        const fetch: typeof globalThis.fetch = (input, init) => {
          const request = new Request(input, init);
          if (request.url.endsWith('/encoded') && request.body)
            expect(request.headers.get('content-type')).toMatch(
              /^application\/x-www-form-urlencoded/,
            );
          if (request.url.endsWith('/upload'))
            expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
          return app.fetch(request);
        };
        expect(await exercise(fetch)).toEqual({
          read: { id: 'u1', tags: ['one', 'two'], team: 'demo' },
          single: { id: 'u2', tags: ['only'], team: 'demo' },
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
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
