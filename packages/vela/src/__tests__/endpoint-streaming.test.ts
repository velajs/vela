import { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, Get, Module, VelaFactory } from '../index';
import { ApiResponse } from '../openapi/index';
import { defineEndpoint, Endpoint } from '../openapi/endpoint';
import { createOpenApiDocument } from '../openapi/document';
import { mapEndpointResponse } from '../http/endpoint-executor';

const input = z.object({});
const context = () => new Context(new Request('https://example.test/'));

describe('native endpoint responses', () => {
  it.each([
    new Blob(['bytes']),
    new TextEncoder().encode('bytes'),
    new TextEncoder().encode('bytes').buffer,
    new TextEncoder().encode('_bytes_').subarray(1, 6),
  ])('maps binary bodies without JSON serialization', async (body) => {
    const endpoint = defineEndpoint({
      input,
      format: 'binary',
      contentType: 'application/pdf',
      status: 206,
    });
    const response = await mapEndpointResponse(context(), endpoint, body);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('bytes');
  });

  it('preserves native responses, status, headers and body identity in all native formats', async () => {
    for (const format of ['binary', 'stream', 'response'] as const) {
      const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
      const response = new Response(body, {
        status: 202,
        statusText: 'Queued',
        headers: {
          'content-type': 'text/event-stream',
          'x-custom': 'kept',
          'content-disposition': 'inline',
        },
      });
      const endpoint = defineEndpoint({ input, format, status: 201 });
      const bound = endpoint.bind(() => response);
      expect(await bound({})).toBe(response);
      const mapped = await mapEndpointResponse(context(), endpoint, response);
      expect(mapped).toBe(response);
      expect(mapped.body).toBe(body);
      expect(mapped.status).toBe(202);
      expect(mapped.statusText).toBe('Queued');
      expect(mapped.headers.get('content-type')).toBe('text/event-stream');
      expect(mapped.headers.get('x-custom')).toBe('kept');
      expect(mapped.headers.get('content-disposition')).toBe('inline');
      await mapped.body?.cancel();
    }
  });

  it('does not pull, buffer, clone or lock a stream and forwards cancellation', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const endpoint = defineEndpoint({ input, format: 'stream', contentType: 'text/event-stream' });
    expect(await endpoint.bind(() => body)({})).toBe(body);
    const response = await mapEndpointResponse(context(), endpoint, body);
    expect(response.body).toBe(body);
    expect(body.locked).toBe(false);
    expect(pull).not.toHaveBeenCalled();
    await response.body?.cancel('reader left');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('reader left');
  });

  it('keeps producer errors on the body reader after headers have been returned', async () => {
    const failure = new Error('producer failed');
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunk++ === 0) controller.enqueue(new TextEncoder().encode('first'));
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const endpoint = defineEndpoint({ input, format: 'stream' });
    const response = await mapEndpointResponse(context(), endpoint, body);
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new TextEncoder().encode('first') });
    await expect(reader.read()).rejects.toBe(failure);
    reader.releaseLock();
  });

  it('rejects invalid, locked and consumed output before handing off a body', async () => {
    const endpoint = defineEndpoint({ input, format: 'stream' });
    await expect(mapEndpointResponse(context(), endpoint, { data: 'wrong' })).rejects.toThrow(
      'native ReadableStream',
    );
    const body = new ReadableStream<Uint8Array>();
    const reader = body.getReader();
    await expect(mapEndpointResponse(context(), endpoint, body)).rejects.toThrow('unlocked');
    reader.releaseLock();
    await body.cancel();
    const consumed = new Response('read');
    await consumed.text();
    await expect(mapEndpointResponse(context(), endpoint, consumed)).rejects.toThrow('unused');
    const binary = defineEndpoint({ input, format: 'binary' });
    await expect(
      mapEndpointResponse(context(), binary, new Uint8Array(new SharedArrayBuffer(1))),
    ).rejects.toThrow('native');
    expect(() =>
      defineEndpoint({ input, format: 'stream', contentType: 'text/event-stream\r\nx-evil: yes' }),
    ).toThrow('media type');
    expect(() => defineEndpoint({ input, format: 'stream', contentType: '*/*' })).toThrow(
      'media type',
    );
  });

  it('keeps runtime metadata, input parsing, streaming and error handling together', async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('chunk'));
    });
    const stream = defineEndpoint({
      input: z.object({ query: z.object({ id: z.string() }) }),
      format: 'stream',
      contentType: 'text/event-stream',
    });
    const raw = defineEndpoint({ input, format: 'response', contentType: 'application/pdf' });
    @Controller('/native')
    class NativeController {
      @Get('/events')
      @Endpoint(stream)
      events(_input: z.output<typeof stream.input>) {
        return new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      }
      @Get('/download')
      @ApiResponse(206, {
        description: 'Partial content',
        format: 'binary',
        contentType: 'application/pdf',
      })
      @Endpoint(raw)
      download() {
        return new Response('file', {
          status: 206,
          headers: { 'content-type': 'application/pdf', 'content-range': 'bytes 0-3/4' },
        });
      }
      @Get('/failed')
      @Endpoint(raw)
      failed(): Response {
        throw new Error('before headers');
      }
      @Get('/invalid')
      @Endpoint(raw)
      invalid(): Response {
        return JSON.parse('{}');
      }
    }
    @Module({ controllers: [NativeController] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const invalidInput = await app.fetch(new Request('https://test/native/events'));
      expect(invalidInput.status).toBe(400);
      expect(pull).not.toHaveBeenCalled();
      await invalidInput.text();
      const response = await app.fetch(new Request('https://test/native/events?id=one'));
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      // The existing request-scope tracker may prefetch one chunk, never the full body.
      expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
      const reader = response.body!.getReader();
      expect((await reader.read()).value).toEqual(new TextEncoder().encode('chunk'));
      await reader.cancel('disconnected');
      expect(cancel).toHaveBeenCalledExactlyOnceWith('disconnected');
      const download = await app.fetch(new Request('https://test/native/download'));
      expect(download.status).toBe(206);
      expect(download.headers.get('content-range')).toBe('bytes 0-3/4');
      expect(await download.text()).toBe('file');
      for (const path of ['failed', 'invalid']) {
        const response = await app.fetch(new Request(`https://test/native/${path}`));
        expect(response.status).toBe(500);
        await response.text();
      }
      const doc = createOpenApiDocument(App);
      expect(doc.paths['/native/events']?.get?.responses['200']).toEqual({
        description: 'Success',
        'x-vela-response-format': 'stream',
        content: { 'text/event-stream': { schema: { type: 'string', format: 'binary' } } },
      });
      expect(doc.paths['/native/download']?.get?.responses['206']).toEqual({
        description: 'Partial content',
        'x-vela-response-format': 'binary',
        content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
      });
      expect(doc.paths['/native/download']?.get?.responses['200']).toEqual({
        description: 'Success',
        'x-vela-response-format': 'response',
        content: { 'application/pdf': { schema: {} } },
      });
    } finally {
      await app.dispose();
    }
  });
});
