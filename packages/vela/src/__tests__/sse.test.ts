import { describe, it, expect } from 'vitest';
import { VelaFactory, Controller, Sse, Get, Module } from '../index.js';

describe('SSE/Streaming', () => {
  it('should register @Sse() as a GET route returning streaming response', async () => {
    @Controller('/stream')
    class StreamController {
      @Sse('/events')
      events() {
        return new Response('data: hello\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
    }

    @Module({ controllers: [StreamController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/stream/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('should support custom path with @Sse("/events")', async () => {
    @Controller('/api')
    class EventController {
      @Sse('/events')
      sse() {
        return new Response('data: test\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
    }

    @Module({ controllers: [EventController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/api/events');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toBe('data: test\n\n');
  });

  it('should pass through Response objects from SSE handlers in full pipeline', async () => {
    @Controller('/notifications')
    class NotificationController {
      @Sse('/live')
      stream() {
        return new Response('data: ping\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      @Get('/count')
      count() {
        return { count: 42 };
      }
    }

    @Module({ controllers: [NotificationController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);

    // SSE endpoint
    const sseRes = await app.getHonoApp().request('/notifications/live');
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toBe('text/event-stream');

    // Regular endpoint still works
    const jsonRes = await app.getHonoApp().request('/notifications/count');
    expect(jsonRes.status).toBe(200);
    expect(await jsonRes.json()).toEqual({ count: 42 });
  });
});
