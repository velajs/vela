/* eslint-disable no-await-in-loop -- Each media type is sent and asserted in order. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Body, Controller, Module, Post, VelaFactory } from '../index';
import { Endpoint, defineEndpoint } from '../openapi/index';
import { readJsonBody } from '../module-kit';

const unsupported = {
  error: { code: 'unsupported_media_type', message: 'Expected application/json body' },
};

// Browsers send `text/plain`, `application/x-www-form-urlencoded` and
// `multipart/form-data` POSTs cross-site without a CORS preflight. A JSON
// handler that parsed those bodies would be reachable by a forged form post.
const rejectedContentTypes = [
  'text/plain',
  'text/plain;charset=UTF-8',
  'application/x-www-form-urlencoded',
  'multipart/form-data; boundary=vela',
  'application/jsonp',
  'application/json-seq',
];

const acceptedContentTypes = [
  'application/json',
  'application/json; charset=utf-8',
  'Application/JSON',
  'application/vnd.api+json',
  'application/merge-patch+json; charset=UTF-8',
];

function post(path: string, contentType: string | undefined, body: string): Request {
  // A byte body keeps the fetch implementation from adding its own content type.
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
    body: new TextEncoder().encode(body),
  });
}

async function createBodyApp() {
  @Controller('/transfers')
  class Transfers {
    @Post()
    create(@Body() body: unknown) {
      return { body: body ?? null };
    }
  }
  @Module({ controllers: [Transfers] })
  class App {}
  return VelaFactory.create(App);
}

describe('@Body() requires a JSON media type', () => {
  it('rejects bodies sent without a JSON content type with 415', async () => {
    const app = await createBodyApp();
    try {
      for (const contentType of [...rejectedContentTypes, undefined]) {
        const res = await app.fetch(post('/transfers', contentType, '{"amount":100}'));
        expect(res.status, String(contentType)).toBe(415);
        expect(await res.json()).toEqual(unsupported);
      }
    } finally {
      await app.close();
    }
  });

  it('parses application/json and +json bodies, with parameters', async () => {
    const app = await createBodyApp();
    try {
      for (const contentType of acceptedContentTypes) {
        const res = await app.fetch(post('/transfers', contentType, '{"amount":100}'));
        expect(res.status, contentType).toBe(200);
        expect(await res.json()).toEqual({ body: { amount: 100 } });
      }
    } finally {
      await app.close();
    }
  });

  it('still resolves a request without a body to undefined', async () => {
    const app = await createBodyApp();
    try {
      const res = await app.fetch(
        new Request('https://example.test/transfers', { method: 'POST' }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ body: null });
    } finally {
      await app.close();
    }
  });
});

async function createEndpointApp(maxBytes?: number) {
  const definition = defineEndpoint({
    input: z.object({ json: z.object({ amount: z.number() }) }),
    output: z.number(),
    ...(maxBytes === undefined ? {} : { body: { contentType: 'application/json', maxBytes } }),
  });
  @Controller('/transfers')
  class Transfers {
    @Post()
    @Endpoint(definition)
    create(value: { json: { amount: number } }) {
      return value.json.amount;
    }
  }
  @Module({ controllers: [Transfers] })
  class App {}
  return VelaFactory.create(App);
}

describe('readJsonBody', () => {
  it('applies the same rule to routes registered directly on Hono', async () => {
    @Module({})
    class App {}
    const app = await VelaFactory.create(App);
    app.getHonoApp().post('/raw', async (c) => c.json({ body: (await readJsonBody(c)) ?? null }));
    try {
      const refused = await app.fetch(post('/raw', 'text/plain', '{"amount":100}'));
      expect(refused.status).toBe(415);
      expect(await refused.json()).toEqual(unsupported);

      const malformed = await app.fetch(post('/raw', 'application/json', '{"amount":'));
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        error: { code: 'bad_request', message: 'Malformed JSON body' },
      });

      const parsed = await app.fetch(post('/raw', 'application/json', '{"amount":100}'));
      expect(await parsed.json()).toEqual({ body: { amount: 100 } });

      const empty = await app.fetch(new Request('https://example.test/raw', { method: 'POST' }));
      expect(await empty.json()).toEqual({ body: null });
    } finally {
      await app.close();
    }
  });
});

describe('endpoint json groups require a JSON media type', () => {
  for (const maxBytes of [undefined, 64]) {
    it(`rejects non-JSON media types with 415 (maxBytes: ${String(maxBytes)})`, async () => {
      const app = await createEndpointApp(maxBytes);
      try {
        for (const contentType of [...rejectedContentTypes, undefined]) {
          const res = await app.fetch(post('/transfers', contentType, '{"amount":100}'));
          expect(res.status, String(contentType)).toBe(415);
          expect(await res.json()).toEqual(unsupported);
        }
        for (const contentType of acceptedContentTypes) {
          const res = await app.fetch(post('/transfers', contentType, '{"amount":100}'));
          expect(res.status, contentType).toBe(200);
          expect(await res.json()).toBe(100);
        }
      } finally {
        await app.close();
      }
    });
  }
});
