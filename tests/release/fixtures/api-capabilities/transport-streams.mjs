import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  Controller,
  Endpoint,
  Get,
  HttpService,
  HttpResponseSizeException,
  Module,
  VelaFactory,
  createOpenApiDocument,
  defineEndpoint,
} from '@velajs/vela';
import {
  createHttpClientTelemetryObserver,
  observabilityAdapter,
} from '@velajs/vela/observability';
import { generateClientContract } from '@velajs/cli/client';
import { hc, readHttpResponse } from '@velajs/client/http';
import { z } from 'zod';

export async function verifyTransportAndStreams() {
  const events = [];
  const telemetry = {
    startSpan(name, options) {
      const event = { name, options, attributes: [], outcomes: [] };
      events.push(event);
      return {
        context: {
          traceId: options?.parent?.traceId ?? '1234567890abcdef1234567890abcdef',
          spanId: events.length.toString(16).padStart(16, '0'),
          traceFlags: 1,
        },
        setAttributes: (attributes) => event.attributes.push(attributes),
        end: (outcome) => event.outcomes.push(outcome),
      };
    },
    createCounter: () => ({ add() {} }),
    createHistogram: () => ({ record() {} }),
  };
  let cancelled = false;
  class Transfers {
    bytes() {
      return new Response(new Uint8Array([0, 128, 255]), {
        status: 206,
        headers: { 'content-type': 'application/octet-stream', 'x-file': 'fixture' },
      });
    }
    stream() {
      return new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([7]));
        },
        cancel() {
          cancelled = true;
        },
      });
    }
    value() {
      return { value: '4' };
    }
  }
  Controller('/transfers')(Transfers);
  for (const [method, definition] of Object.entries({
    bytes: defineEndpoint({
      input: z.object({}),
      format: 'binary',
      status: 206,
      contentType: 'application/octet-stream',
    }),
    stream: defineEndpoint({
      input: z.object({}),
      format: 'stream',
      contentType: 'application/octet-stream',
    }),
    value: defineEndpoint({ input: z.object({}), output: z.object({ value: z.string() }) }),
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(Transfers.prototype, method);
    Get(`/${method}`)(Transfers.prototype, method, descriptor);
    Endpoint(definition)(Transfers.prototype, method, descriptor);
  }
  class Application {}
  Module({ controllers: [Transfers] })(Application);
  const app = await VelaFactory.create(Application, {
    adapters: [observabilityAdapter({ telemetry, trustIncomingTraceContext: true })],
  });
  const pending = [];
  const context = {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
    props: {},
  };
  const transport = (input, init) => app.fetch(new Request(input, init), {}, context);
  try {
    const generated = generateClientContract(createOpenApiDocument(Application));
    assert.deepEqual(generated.warnings, []);
    await writeFile('generated-streams.ts', generated.source);
    const client = hc('https://fixture.test', { fetch: transport });
    const response = await readHttpResponse(client.transfers.bytes.$get(), 'response');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('x-file'), 'fixture');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
    const stream = await readHttpResponse(client.transfers.stream.$get(), 'stream');
    assert.ok(stream);
    const reader = stream.getReader();
    assert.deepEqual((await reader.read()).value, new Uint8Array([7]));
    await reader.cancel();
    assert.equal(cancelled, true);

    let seen;
    const service = new HttpService({
      baseURL: 'https://fixture.test',
      maxResponseBytes: 256,
      observer: createHttpClientTelemetryObserver({ telemetry }),
      transport(input, init) {
        seen = new Request(input, init);
        return transport(input, init);
      },
    });
    const result = await service.get('/transfers/value?existing=1#section', {
      params: { q: 'private-query' },
      schema: z.object({ value: z.string().transform(Number) }),
    });
    assert.deepEqual(result.data, { value: 4 });
    assert.equal(new URL(seen.url).searchParams.get('existing'), '1');
    assert.equal(new URL(seen.url).searchParams.get('q'), 'private-query');
    assert.match(seen.headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await assert.rejects(
      service.get('/transfers/value', { maxResponseBytes: 1 }),
      HttpResponseSizeException,
    );
    const abort = new AbortController();
    abort.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(service.get('/transfers/value', { signal: abort.signal }), {
      name: 'AbortError',
    });
    await Promise.all(pending);
    assert.ok(events.some((event) => event.options?.kind === 'server' && event.options.parent));
    assert.ok(events.some((event) => event.outcomes[0] === 'cancelled'));
    assert.ok(events.every((event) => event.outcomes.length === 1));
    assert.doesNotMatch(JSON.stringify(events), /private-query|section|existing=/);
  } finally {
    await app.close();
  }
}
