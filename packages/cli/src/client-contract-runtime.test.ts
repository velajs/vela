import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Controller,
  Endpoint,
  Get,
  Module,
  Post,
  VelaFactory,
  createOpenApiDocument,
  defineEndpoint,
} from '@velajs/vela';
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
      import { hc } from '@velajs/client/http';
      import type { AppType } from './api.js';
      export async function exercise(fetch: typeof globalThis.fetch) {
        const client = hc<AppType>('https://api.test', { fetch });
        const response = await client.api.users[':id'].$get({ param: { id: 'u1' }, query: { tag: ['one', 'two'] }, header: { 'x-team': 'demo' } });
        const read = await response.json();
        const created = await client.api.users.$post({ json: { name: 'Ada' } });
        const status: 201 = created.status;
        const user = await created.json();
        user.name.toUpperCase();
        return { read, user, status };
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
    const fetch: typeof globalThis.fetch = (input, init) => app.fetch(new Request(input, init));
    expect(await consumer.exercise(fetch)).toEqual({
      read: { id: 'u1', tags: ['one', 'two'], team: 'demo' },
      user: { id: 'u1', name: 'Ada' },
      status: 201,
    });
  } finally {
    await app.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
