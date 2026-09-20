import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Controller,
  Get,
  Injectable,
  Inject,
  MetadataRegistry,
  getCurrentContainer,
  getCurrentRequestContext,
} from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('ambient container (opt-in)', () => {
  it('exposes the request container + RequestContext to deep code when enabled', async () => {
    @Injectable()
    class Deep {
      whoAmI(): string {
        // Reaches the request container without a Hono Context threaded in.
        const container = getCurrentContainer();
        expect(container).toBeDefined();
        return getCurrentRequestContext().id;
      }
    }

    @Controller('ambient')
    class AmbientController {
      constructor(@Inject(Deep) private readonly deep: Deep) {}
      @Get()
      handle(): { id: string } {
        return { id: this.deep.whoAmI() };
      }
    }

    @Module({ providers: [Deep], controllers: [AmbientController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, { ambientContainer: true });
    const res = await app.getHonoApp().request('/ambient', {
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'req-123' });
  });

  it('throws a helpful error when called outside a request / not enabled', () => {
    expect(() => getCurrentContainer()).toThrow(/ambient/i);
  });

  it('does not activate ambient access unless opted in', async () => {
    @Controller('no-ambient')
    class NoAmbientController {
      @Get()
      handle(): { ok: boolean } {
        // Not enabled → ambient read must fail even inside a request.
        expect(() => getCurrentContainer()).toThrow(/ambient/i);
        return { ok: true };
      }
    }

    @Module({ controllers: [NoAmbientController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule); // ambientContainer omitted
    const res = await app.getHonoApp().request('/no-ambient');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('application disposal', () => {
  it('disposes container-constructed singletons in LIFO order on dispose()', async () => {
    const order: string[] = [];

    @Injectable()
    class Dep {
      dispose(): void {
        order.push('Dep');
      }
    }

    @Injectable()
    class Root {
      constructor(@Inject(Dep) readonly dep: Dep) {}
      dispose(): void {
        order.push('Root');
      }
    }

    @Module({ providers: [Dep, Root], exports: [Root] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    // Force construction: Root depends on Dep, so Dep is built first.
    app.get(Root);

    await app.dispose();

    // Creation order [Dep, Root] → LIFO disposal [Root, Dep].
    expect(order).toEqual(['Root', 'Dep']);
  });

  it('does not throw if a disposer errors, and still disposes the rest', async () => {
    const disposed: string[] = [];

    @Injectable()
    class Bad {
      dispose(): void {
        throw new Error('boom');
      }
    }

    @Injectable()
    class Good {
      dispose(): void {
        disposed.push('Good');
      }
    }

    @Module({ providers: [Bad, Good], exports: [Bad, Good] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    app.get(Bad);
    app.get(Good);

    await expect(app.dispose()).resolves.toBeUndefined();
    expect(disposed).toEqual(['Good']);
  });
});
