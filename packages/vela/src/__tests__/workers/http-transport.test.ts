import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { HttpService, HttpResponseSizeException } from '../../fetch';

describe('HTTP transport on native Workers', () => {
  it('uses an actual Fetcher binding and validates the response', async () => {
    const http = new HttpService({ transport: SELF, baseURL: 'http://example.com' });
    const response = await http.get('/health', {
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(value: unknown) {
            if (
              !value ||
              typeof value !== 'object' ||
              !('status' in value) ||
              value.status !== 'ok'
            )
              return { issues: [{ message: 'Invalid health response' }] };
            return { value: { healthy: true } };
          },
        },
      },
    });
    expect(response.data).toEqual({ healthy: true });
  });

  it('forwards multipart forms with runtime-generated boundaries', async () => {
    const form = new FormData();
    form.append('name', 'sample');
    form.append('file', new Blob([new Uint8Array([0, 255])]), 'data.bin');
    const http = new HttpService({
      headers: { 'CONTENT-TYPE': 'application/json' },
      transport: async (url, init) => {
        const request = new Request(url, init);
        expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        const parsed = await request.formData();
        expect(parsed.get('name')).toBe('sample');
        const file = parsed.get('file');
        if (!(file instanceof Blob)) throw new Error('Expected binary form field');
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
        return new Response(null, { status: 204 });
      },
    });
    expect((await http.post('http://example.com/upload', form)).data).toBeUndefined();
  });

  it('forwards typed array views, URLSearchParams and streams as Web request bodies', async () => {
    const observed: Uint8Array[] = [];
    const http = new HttpService({
      transport: async (url, init) => {
        observed.push(new Uint8Array(await new Request(url, init).arrayBuffer()));
        return new Response('ok');
      },
    });
    await http.post(
      'http://example.com/upload',
      new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2),
    );
    await http.post('http://example.com/upload', new URLSearchParams({ key: 'value' }));
    await http.post(
      'http://example.com/upload',
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255]));
          controller.close();
        },
      }),
    );
    expect(observed).toEqual([
      new Uint8Array([2, 3]),
      new TextEncoder().encode('key=value'),
      new Uint8Array([0, 255]),
    ]);
  });

  it('enforces streaming byte limits independent of Content-Length', async () => {
    const cancel = vi.fn();
    const http = new HttpService({
      maxResponseBytes: 3,
      transport: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('éé'));
            },
            cancel,
          }),
          { headers: { 'Content-Length': '0' } },
        ),
    });
    await expect(http.get('http://example.com/large')).rejects.toBeInstanceOf(
      HttpResponseSizeException,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('composes caller cancellation with a timeout while reading a stalled body', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const http = new HttpService({
      timeout: 10_000,
      transport: async (_url, init) => {
        expect(init?.signal).not.toBe(controller.signal);
        return new Response(
          new ReadableStream({
            pull() {
              started.resolve();
            },
            cancel,
          }),
        );
      },
    });
    const pending = http.get('http://example.com/stalled', { signal: controller.signal });
    const reason = new DOMException('Caller cancelled', 'AbortError');
    const outcome = expect(pending).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await outcome;
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it('times out a transport that ignores the signal', async () => {
    const http = new HttpService({ timeout: 1, transport: () => new Promise(() => {}) });
    await expect(http.get('http://example.com/stalled')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});
