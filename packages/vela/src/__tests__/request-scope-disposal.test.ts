import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Controller,
  Get,
  Injectable,
  Inject,
  Scope,
  MetadataRegistry,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('request-scoped disposal (HTTP)', () => {
  it('disposes a request-scoped disposable after a buffered response', async () => {
    const disposed: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class UnitOfWork {
      async dispose(): Promise<void> {
        disposed.push('uow');
      }
    }

    @Controller('uow')
    class UowController {
      constructor(@Inject(UnitOfWork) private readonly uow: UnitOfWork) {
        void this.uow;
      }
      @Get()
      handle(): { ok: boolean } {
        return { ok: true };
      }
    }

    @Module({ providers: [UnitOfWork], controllers: [UowController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/uow');
    await res.text();
    await tick();
    expect(disposed).toEqual(['uow']);
  });

  it('defers disposal until a streaming body is fully read', async () => {
    const events: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class StreamResource {
      async dispose(): Promise<void> {
        events.push('disposed');
      }
    }

    @Controller('stream')
    class StreamController {
      constructor(@Inject(StreamResource) private readonly r: StreamResource) {
        void this.r;
      }
      @Get()
      handle(): Response {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk'));
            controller.close();
          },
        });
        return new Response(stream);
      }
    }

    @Module({ providers: [StreamResource], controllers: [StreamController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/stream');

    // Body not yet consumed → resource must NOT be disposed (streaming-safe).
    expect(events).not.toContain('disposed');

    const text = await res.text();
    expect(text).toBe('chunk');
    await tick();
    expect(events).toContain('disposed');
  });

  it('disposes on the error path', async () => {
    const disposed: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class Res {
      async dispose(): Promise<void> {
        disposed.push('res');
      }
    }

    @Controller('boom')
    class BoomController {
      constructor(@Inject(Res) private readonly r: Res) {
        void this.r;
      }
      @Get()
      handle(): never {
        throw new Error('kaboom');
      }
    }

    @Module({ providers: [Res], controllers: [BoomController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/boom');
    await res.text().catch(() => undefined);
    await tick();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(disposed).toEqual(['res']);
  });
});
