import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Controller, Get, Module, VelaFactory } from '@velajs/vela';
import { ApiResponse, createOpenApiDocument } from '@velajs/vela/openapi';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { generateClientContract } from './client-contract';

function document(content: unknown, format?: unknown) {
  return {
    openapi: '3.1.0',
    paths: {
      '/data': {
        get: {
          responses: {
            200: {
              content,
              ...(format === undefined ? {} : { 'x-vela-response-format': format }),
            },
          },
        },
      },
    },
  };
}

describe('native response client contracts', () => {
  it.each([
    ['application/octet-stream', 'binary', 'Blob'],
    ['text/event-stream', 'stream', 'ReadableStream<Uint8Array> | null'],
    ['application/x-ndjson', 'stream', 'ReadableStream<Uint8Array> | null'],
    ['application/pdf', 'binary', 'Blob'],
    ['image/png', 'binary', 'Blob'],
  ])('generates honest native consumption for %s', (media, format, output) => {
    const result = generateClientContract(
      document({ [media]: { schema: { type: 'string', format: 'binary' } } }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.source).toContain(`output: ${output}; outputFormat: '${format}'`);
  });

  it('uses explicit native metadata even for JSON media and refuses invalid metadata', () => {
    const result = generateClientContract(
      document(
        {
          'application/json': {
            schema: { type: 'object', properties: { unsafe: { type: 'string' } } },
          },
        },
        'response',
      ),
    );
    expect(result.source).toContain("output: unknown; outputFormat: 'response'");
    expect(result.warnings).toEqual([]);
    expect(() => generateClientContract(document({}, 'made-up'))).toThrow('x-vela-response-format');
  });

  it('represents content negotiation as unknown instead of choosing a JSON schema', () => {
    const result = generateClientContract(
      document({
        'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
        'application/pdf': { schema: { type: 'string', format: 'binary' } },
      }),
    );
    expect(result.source).toContain("output: unknown; outputFormat: 'response'");
    expect(result.warnings).toEqual([]);
  });

  it('compiles and runs generated native calls through the actual route pipeline', async () => {
    const cancel = vi.fn();
    @Controller('/files')
    class Files {
      @Get('/download', { format: 'binary', contentType: 'application/pdf' })
      download() {
        return new Blob(['pdf']);
      }
      @Get('/events', { format: 'stream', contentType: 'text/event-stream' })
      @ApiResponse({
        status: 503,
        description: 'Unavailable',
        schema: z.object({ message: z.string() }),
      })
      events() {
        return new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
      }
      @Get('/raw', { format: 'response', contentType: 'application/json', status: 202 })
      raw() {
        return Response.json(
          { value: 'unchecked' },
          { status: 202, headers: { 'x-native': 'preserved' } },
        );
      }
    }
    @Module({ controllers: [Files] })
    class App {}
    const app = await VelaFactory.create(App);
    const dir = mkdtempSync(join(process.cwd(), '.client-streaming-'));
    try {
      const result = generateClientContract(createOpenApiDocument(App));
      expect(result.warnings).toEqual([]);
      writeFileSync(join(dir, 'api.ts'), result.source);
      writeFileSync(
        join(dir, 'consumer.ts'),
        `
        import { hc, readHttpResponse } from '@velajs/client/http';
        import type { AppType } from './api.js';
        export async function exercise(fetch: typeof globalThis.fetch) {
          const client = hc<AppType>('https://test', { fetch });
          const download = await client.files.download.$get();
          const blob: Blob = await readHttpResponse(download, 'blob');
          const events = await client.files.events.$get();
          if (events.status === 503) {
            const message: string = (await events.json()).message;
            throw new Error(message);
          }
          const bytes: ReadableStream<Uint8Array> | null = await readHttpResponse(events, 'stream');
          const reader = bytes!.getReader();
          const first = new TextDecoder().decode((await reader.read()).value);
          await reader.cancel('finished');
          const raw = await client.files.raw.$get();
          const status: 202 = raw.status;
          const response = await readHttpResponse(raw, 'response');
          const native: Response = response;
          const nativeStatus: 202 = response.status;
          void nativeStatus;
          const data: unknown = await response.json();
          if (false) {
            // @ts-expect-error Binary bodies do not establish parsed JSON types.
            const binaryJson: { arbitrary: string } = await download.json();
            // @ts-expect-error Streaming bytes do not establish parsed JSON types.
            const streamJson: { arbitrary: string } = await events.json();
            // @ts-expect-error Native application/json still needs consumer validation.
            const rawJson: { value: string } = await raw.json();
            // @ts-expect-error Clones also have unknown JSON results.
            const cloneJson: { value: string } = await response.clone().json();
          }
          return { blob: await blob.text(), type: blob.type, first, status, header: native.headers.get('x-native'), data };
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
        execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], {
          encoding: 'utf8',
        });
      } catch (error) {
        throw new Error(
          String(error instanceof Error && 'stdout' in error ? error.stdout : error),
          { cause: error },
        );
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
        throw new Error('Missing compiled consumer');
      const fetch: typeof globalThis.fetch = (input, init) => app.fetch(new Request(input, init));
      expect(await consumer.exercise(fetch)).toEqual({
        blob: 'pdf',
        type: 'application/pdf',
        first: 'data: hello\n\n',
        status: 202,
        header: 'preserved',
        data: { value: 'unchecked' },
      });
      expect(cancel).toHaveBeenCalledExactlyOnceWith('finished');
    } finally {
      await app.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
