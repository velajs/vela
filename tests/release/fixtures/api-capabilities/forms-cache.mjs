import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
  VelaFactory,
} from '@velajs/vela';
import {
  CacheResponse,
  MemoryCacheInvalidationStore,
  MemoryCacheStore,
  ResponseCacheModule,
  ResponseCacheService,
} from '@velajs/vela/cache';
import { createOpenApiDocument } from '@velajs/vela/openapi';
import { getTrustedRequestIdentity, setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { generateClientContract } from '@velajs/cli/client';
import { hc, withFormEncoding } from '@velajs/client/http';
import { z } from 'zod';

export async function verifyFormsAndCache() {
  const backing = new MemoryCacheStore(30);
  const store = {
    get: async (key) => backing.get(key),
    set: async (key, value, ttl) => backing.set(key, value, ttl),
    del: async (key) => backing.del(key),
    clear: async () => backing.clear(),
  };
  let authorizationChecks = 0;
  let summaryCalls = 0;
  class AccessGuard {
    canActivate(context) {
      authorizationChecks++;
      const request = context.getRequest();
      const subject = new Map([
        ['Bearer fixture-alpha', 'alpha'],
        ['Bearer fixture-beta', 'beta'],
      ]).get(request.headers.get('authorization'));
      if (!subject) throw new UnauthorizedException();
      setTrustedRequestIdentity(request, {
        principal: { issuer: 'packed-consumer', subject, principalType: 'user' },
        tenantId: 'fixture',
      });
      return true;
    }
  }
  Injectable()(AccessGuard);
  const scopeFor = (subject) => ({
    visibility: 'private',
    partition: JSON.stringify(['fixture', subject]),
  });
  const UploadForm = z.object({
    label: z.string().transform((value) => value.trim()),
    labels: z.array(z.string()),
    file: z.file(),
    extra: z.array(z.file()).optional(),
  });
  const Uploaded = z.object({
    id: z.string(),
    label: z.string(),
    labels: z.array(z.string()),
    size: z.number(),
    names: z.array(z.string()),
  });
  const SubmitForm = z.object({
    label: z.string(),
    labels: z.array(z.string()),
    count: z.string().transform(Number),
  });
  const Submitted = z.object({ label: z.string(), labels: z.array(z.string()), count: z.number() });
  class Records {
    summary() {
      return { count: ++summaryCalls };
    }
    upload(id, form) {
      return {
        id,
        label: form.label,
        labels: form.labels,
        size: form.file.size,
        names: [form.file, ...(form.extra ?? [])].map((file) => file.name),
      };
    }
    submit(form) {
      return form;
    }
  }
  Controller('/records')(Records);
  UseGuards(AccessGuard)(Records);
  const decorate = (name, ...decorators) => {
    const descriptor = Object.getOwnPropertyDescriptor(Records.prototype, name);
    for (const decorator of decorators) decorator(Records.prototype, name, descriptor);
  };
  const parameter = (name, index, decorator) => decorator(Records.prototype, name, index);
  decorate(
    'summary',
    Get('/summary', { response: z.object({ count: z.number() }) }),
    CacheResponse({ tags: ['records'] }),
  );
  parameter('upload', 0, Param('id'));
  parameter('upload', 1, Body(UploadForm));
  decorate(
    'upload',
    Post('/:id/attachments', {
      response: Uploaded,
      body: { multipart: { maxBytes: 8192, maxFields: 8, maxFiles: 3, maxFileBytes: 512 } },
    }),
  );
  parameter('submit', 0, Body(SubmitForm));
  decorate(
    'submit',
    Post('/submit', { response: Submitted, status: 200, body: { form: { maxBytes: 1024 } } }),
  );
  class Application {}
  Module({
    imports: [
      ResponseCacheModule.forRoot({
        namespace: 'packed-consumer',
        store,
        invalidation: new MemoryCacheInvalidationStore(),
        scope: (context) => {
          const identity = getTrustedRequestIdentity(context.getRequest());
          return identity ? scopeFor(identity.principal.subject) : undefined;
        },
      }),
    ],
    controllers: [Records],
    providers: [AccessGuard],
  })(Application);
  const app = await VelaFactory.create(Application);
  try {
    const generated = generateClientContract(createOpenApiDocument(Application));
    assert.deepEqual(generated.warnings, []);
    await writeFile('generated-api.ts', generated.source);
    const { formEncodings } = await import('./generated-api.ts');
    assert.equal(formEncodings.length, 2);
    const received = [];
    const transport = async (input, init) => {
      const request = new Request(input, init);
      received.push({
        path: new URL(request.url).pathname,
        type: request.headers.get('content-type'),
      });
      return app.fetch(request);
    };
    const client = hc('https://fixture.test', {
      fetch: withFormEncoding(formEncodings, transport),
      headers: { authorization: 'Bearer fixture-alpha' },
    });
    const response = await client.records[':id'].attachments.$post({
      param: { id: 'one' },
      form: {
        label: '  Document  ',
        labels: ['first', 'second'],
        file: new File(['hello'], 'document.txt', { type: 'text/plain' }),
        extra: [new File(['x'], 'extra.txt', { type: 'text/plain' })],
      },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      id: 'one',
      label: 'Document',
      labels: ['first', 'second'],
      size: 5,
      names: ['document.txt', 'extra.txt'],
    });
    const formResponse = await client.records.submit.$post({
      form: { label: 'a+b & c', labels: ['first', 'second'], count: '7' },
    });
    assert.equal(formResponse.status, 200);
    assert.deepEqual(await formResponse.json(), {
      label: 'a+b & c',
      labels: ['first', 'second'],
      count: 7,
    });
    assert.match(received[0].type, /^multipart\/form-data; boundary=/);
    assert.match(received[1].type, /^application\/x-www-form-urlencoded/);

    const request = (token) =>
      app.fetch(
        new Request('https://fixture.test/records/summary', {
          headers: token ? { authorization: `Bearer fixture-${token}` } : {},
        }),
      );
    const checks = authorizationChecks;
    assert.deepEqual(await (await request('alpha')).json(), { count: 1 });
    assert.deepEqual(await (await request('alpha')).json(), { count: 1 });
    assert.equal(authorizationChecks, checks + 2, 'a cache hit must still authorize');
    assert.equal((await request()).status, 401);
    assert.deepEqual(await (await request('beta')).json(), { count: 2 });
    const cache = app.get(ResponseCacheService);
    assert.deepEqual(await cache.scope(scopeFor('alpha')).invalidateTags(['records']), {
      ok: true,
    });
    assert.deepEqual(await (await request('alpha')).json(), { count: 3 });
    assert.deepEqual(await (await request('beta')).json(), { count: 2 });

    const oversized = await client.records[':id'].attachments.$post({
      param: { id: 'one' },
      form: { label: 'large', labels: ['first'], file: new File(['x'.repeat(513)], 'large.txt') },
    });
    assert.equal(oversized.status, 413);
    const denied = await app.fetch(
      new Request('https://fixture.test/records/one/attachments', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data' },
        body: 'malformed',
      }),
    );
    assert.equal(denied.status, 401, 'guards must run before form parsing');
  } finally {
    await app.close();
  }
}
