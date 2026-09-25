import { describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, VelaFactory } from '../../index';

describe('native route responses in workerd', () => {
  it('preserves streaming headers, byte chunks and cancellation without draining the producer', async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('event'));
    });
    @Controller('/native')
    class Routes {
      @Get('/events', { format: 'stream', contentType: 'text/event-stream' })
      events() {
        return new Response(
          new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
          {
            status: 202,
            headers: { 'content-type': 'text/event-stream', 'x-native': 'kept' },
          },
        );
      }
      @Get('/download', { format: 'binary', contentType: 'application/pdf' })
      download() {
        return new Uint8Array([0, 128, 255]);
      }
      @Get('/broken', { format: 'stream' })
      broken() {
        return new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.error(new Error('producer failed'));
            },
          },
          { highWaterMark: 0 },
        );
      }
    }
    @Module({ controllers: [Routes] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.fetch(new Request('https://test/native/events'));
      expect(response.status).toBe(202);
      expect(response.headers.get('x-native')).toBe('kept');
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
      const reader = response.body!.getReader();
      expect((await reader.read()).value).toEqual(new TextEncoder().encode('event'));
      await reader.cancel('finished');
      reader.releaseLock();
      expect(cancel).toHaveBeenCalledExactlyOnceWith('finished');
      const downloaded = await app.fetch(new Request('https://test/native/download'));
      expect(downloaded.headers.get('content-type')).toBe('application/pdf');
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
      const broken = await app.fetch(new Request('https://test/native/broken'));
      expect(broken.status).toBe(200);
      await expect(broken.text()).rejects.toThrow('producer failed');
    } finally {
      await app.dispose();
    }
  });
});
