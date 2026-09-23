import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Module,
  Controller,
  Get,
  Injectable,
  Inject,
  Scope,
  forwardRef,
} from '../index.js';

describe('request-scope bubbling', () => {
  it('rebuilds a singleton controller per request when it depends on a request-scoped provider', async () => {
    let constructed = 0;

    @Injectable({ scope: Scope.REQUEST })
    class RequestCounter {
      readonly n: number;
      constructor() {
        this.n = ++constructed;
      }
    }

    @Controller('c')
    class C {
      constructor(@Inject(RequestCounter) private readonly counter: RequestCounter) {}
      @Get()
      handle(): { n: number } {
        return { n: this.counter.n };
      }
    }

    @Module({ providers: [RequestCounter], controllers: [C] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await (await hono.request('/c')).json();
    const r2 = await (await hono.request('/c')).json();

    // Fresh per request → the controller (and its request-scoped dep) is
    // rebuilt each request instead of capturing the first one.
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 2 });
  });

  it('keeps a controller singleton when it depends only on singletons', async () => {
    let constructed = 0;

    @Injectable()
    class SingletonSvc {
      readonly n = ++constructed;
    }

    @Controller('s')
    class S {
      constructor(@Inject(SingletonSvc) private readonly svc: SingletonSvc) {}
      @Get()
      handle(): { n: number } {
        return { n: this.svc.n };
      }
    }

    @Module({ providers: [SingletonSvc], controllers: [S] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await (await hono.request('/s')).json();
    const r2 = await (await hono.request('/s')).json();

    // Singleton reused across requests.
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 1 });
  });

  it('bubbles transitively (singleton → singleton → request)', async () => {
    let leafBuilds = 0;

    @Injectable({ scope: Scope.REQUEST })
    class Leaf {
      readonly n = ++leafBuilds;
    }

    @Injectable()
    class Mid {
      constructor(@Inject(Leaf) readonly leaf: Leaf) {}
    }

    @Controller('t')
    class T {
      constructor(@Inject(Mid) private readonly mid: Mid) {}
      @Get()
      handle(): { n: number } {
        return { n: this.mid.leaf.n };
      }
    }

    @Module({ providers: [Leaf, Mid], controllers: [T] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await (await hono.request('/t')).json();
    const r2 = await (await hono.request('/t')).json();
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 2 });
  });

  it('bubbles BOTH members of a forwardRef cycle when one depends on a request provider', async () => {
    let rBuilds = 0;

    @Injectable({ scope: Scope.REQUEST })
    class R {
      readonly n = ++rBuilds;
    }

    // A <-> B forwardRef cycle; A also depends on request-scoped R, listed AFTER
    // the cyclic dep (the ordering that broke the old recursive DFS).
    @Injectable()
    class A {
      constructor(
        @Inject(forwardRef(() => B)) readonly b: unknown,
        @Inject(R) readonly r: R,
      ) {}
    }

    @Injectable()
    class B {
      constructor(@Inject(forwardRef(() => A)) readonly a: A) {}
    }

    // Handler reaches R through B -> A -> R, proving B (a cycle member) is also
    // request-scoped and thus rebuilt per request.
    @Controller('cycle')
    class CycleController {
      constructor(@Inject(B) private readonly b: B) {}
      @Get()
      handle(): { n: number } {
        return { n: this.b.a.r.n };
      }
    }

    @Module({ providers: [A, B, R], controllers: [CycleController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const hono = app.getHonoApp();

    const r1 = await (await hono.request('/cycle')).json();
    const r2 = await (await hono.request('/cycle')).json();
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 2 });
  });
});
