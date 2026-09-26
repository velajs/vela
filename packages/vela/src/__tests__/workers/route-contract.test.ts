import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_INTERCEPTOR,
  Body,
  Controller,
  Get,
  Module,
  Post,
  RawBody,
  VelaFactory,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '../../index';
import { CacheInterceptor, CacheModule, CacheResponse } from '../../cache/index';
import { defineRoute, type ContractBody } from '../../contract/index';
import { createOpenApiDocument } from '../../openapi/index';
import type { SchemaOutput } from '../../validation/index';

const MiB = 1024 * 1024;
const Greeting = z.object({ name: z.string().min(1) });
const Greeted = z.object({ greeting: z.string() });
const Upload = z.object({
  kind: z.enum(['avatar', 'banner']),
  ownerId: z.uuid(),
  description: z.string().optional(),
  file: z.file(),
});
const greet = defineRoute({
  method: 'POST',
  path: '/greetings/shared',
  body: Greeting,
  response: Greeted,
});

@Controller('/greetings')
class Greetings {
  @Post({ response: Greeted })
  create(@Body(Greeting) value: SchemaOutput<typeof Greeting>) {
    return { greeting: `Hello, ${value.name}`, internal: true };
  }

  @Post('/shared', greet)
  shared(@Body() value: ContractBody<typeof greet>) {
    return { greeting: `Hi, ${value.name}` };
  }

  @Post('/upload', {
    response: z.object({ kind: z.string(), bytes: z.number() }),
    body: {
      multipart: { maxFileBytes: 25 * MiB, maxFiles: 1, maxFields: 10, maxFieldBytes: 16 * 1024 },
    },
  })
  async upload(@Body(Upload) form: SchemaOutput<typeof Upload>) {
    return { kind: form.kind, bytes: (await form.file.arrayBuffer()).byteLength };
  }
}
const archive = defineRoute({
  method: 'POST',
  path: '/tasks/:id/archive',
  params: z.object({ id: z.uuid() }),
  query: z.object({ confirm: z.literal('yes') }),
  body: z.object({ reason: z.string().min(3) }),
  response: z.object({ ok: z.boolean() }),
});

let reads = 0;

// Adds a field in place to what the cached route returns, outside the cache.
class Stamp implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const value = await next.handle();
    if (context.getHandlerName() === 'cached' && value !== null && typeof value === 'object')
      Reflect.set(value, 'internal', true);
    return value;
  }
}

@Controller('/tasks')
class Tasks {
  @Post('/:id/archive', archive)
  archiveIt() {
    return { ok: true };
  }

  @Post('/notes', { body: { json: { maxBytes: 64 } } })
  note(@Body() body: unknown, @RawBody() raw: Uint8Array) {
    return { body, bytes: raw.byteLength };
  }

  @Get('/cached', { response: z.object({ reads: z.number() }) })
  @CacheResponse({ ttl: 60 })
  cached() {
    return { reads: ++reads };
  }
}

@Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: Stamp }] })
class StampModule {}

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useExisting: CacheInterceptor }],
  imports: [
    StampModule,
    CacheModule.forRoot({
      namespace: 'workers',
      scope: () => ({ visibility: 'public', partition: 'tasks' }),
    }),
  ],
  controllers: [Greetings, Tasks],
})
class App {}

function json(path: string, body: unknown): Request {
  return new Request(`http://example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('route contracts inside bare workerd', () => {
  it('uses the same schemas at the HTTP and OpenAPI boundaries', async () => {
    const app = await VelaFactory.create(App);
    try {
      expect((await app.fetch(json('/greetings', { name: 42 }))).status).toBe(400);
      const response = await app.fetch(json('/greetings', { name: 'Ada' }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ greeting: 'Hello, Ada' });
      const shared = await app.fetch(json('/greetings/shared', { name: 'Lin' }));
      expect(await shared.json()).toEqual({ greeting: 'Hi, Lin' });
      const document = createOpenApiDocument(App);
      for (const path of ['/greetings', '/greetings/shared']) {
        expect(
          document.paths[path]?.post?.responses['201']?.content?.['application/json']?.schema,
        ).toMatchObject({ type: 'object', properties: { greeting: { type: 'string' } } });
      }
    } finally {
      await app.close();
    }
  });

  it('reads a bounded multipart upload with typed fields and answers 413 and 415', async () => {
    const app = await VelaFactory.create(App);
    try {
      const form = new FormData();
      form.append('kind', 'avatar');
      form.append('ownerId', '2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f');
      form.append('description', 'Profile picture');
      form.append('file', new File([new Uint8Array(2 * MiB)], 'avatar.png'));
      const uploaded = await app.fetch(
        new Request('http://example.test/greetings/upload', { method: 'POST', body: form }),
      );
      expect(uploaded.status).toBe(201);
      expect(await uploaded.json()).toEqual({ kind: 'avatar', bytes: 2 * MiB });

      const oversized = new FormData();
      oversized.append('kind', 'avatar');
      oversized.append('ownerId', '2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f');
      oversized.append('file', new File([new Uint8Array(25 * MiB + 1)], 'big.bin'));
      const tooLarge = await app.fetch(
        new Request('http://example.test/greetings/upload', { method: 'POST', body: oversized }),
      );
      expect(tooLarge.status).toBe(413);

      const wrongMedia = await app.fetch(json('/greetings/upload', { kind: 'avatar' }));
      expect(wrongMedia.status).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('validates every group a contract declares and lets a later reader read a bounded body', async () => {
    const app = await VelaFactory.create(App);
    try {
      const path = '/tasks/2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f/archive';
      const plain = await app.fetch(
        new Request(`http://example.test${path}?confirm=yes`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'x',
        }),
      );
      expect(plain.status).toBe(415);
      expect((await app.fetch(json(path, { reason: 'done' }))).status).toBe(400);
      expect((await app.fetch(json(`${path}?confirm=yes`, { reason: 'done' }))).status).toBe(201);
      const note = await app.fetch(json('/tasks/notes', { a: 1 }));
      expect(await note.json()).toEqual({ body: { a: 1 }, bytes: 7 });
    } finally {
      await app.close();
    }
  });

  it('replays the response a cached route sent, after interceptors outside the cache', async () => {
    const app = await VelaFactory.create(App);
    try {
      for (let i = 0; i < 2; i++) {
        const response = await app.fetch(new Request('http://example.test/tasks/cached'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ reads: 1 });
      }
    } finally {
      await app.close();
    }
  });
});
