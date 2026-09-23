import { beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';
import {
  All,
  Controller,
  Get,
  HttpMethod,
  Injectable,
  MetadataRegistry,
  Module,
  Post,
  VelaFactory,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type RouteInfo,
  type Type,
  type VelaHono,
} from '../index';

// Differential property sweep for consumer middleware: a seeded generator
// builds route patterns and request paths, and every sample compares Vela's
// decision with Hono's own router. A mismatch where Vela skips the middleware
// is a fail-open.

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[next() % values.length]!;
}

const LITERALS = ['a', 'b', 'users', 'v1.0', 'é'] as const;
const CONSTRAINTS = ['[0-9]+', '[a-z]+', '[a-z0-9]{2}'] as const;
// Request segments: route literals, parameter values, an empty segment,
// unicode, every line terminator Hono decodes into c.req.path, and a long one.
const PATH_SEGMENTS = [
  ...LITERALS,
  '1',
  '42',
  'x',
  '',
  '日本',
  '%0A',
  'a%0D',
  '%E2%80%A8',
  '%E2%80%A9x',
  '1%0A',
  'a'.repeat(2048),
] as const;
const REQUEST_METHODS = ['GET', 'HEAD', 'POST', 'DELETE', 'ALL'] as const;

// A route pattern in Hono syntax: static text, ':param', ':param{regex}', and
// a trailing '*' or optional ':param?'.
function routePattern(next: () => number): string {
  const count = 1 + (next() % 3);
  const segments: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const kind = next() % (last ? 6 : 4);
    if (kind < 2) segments.push(pick(next, LITERALS));
    else if (kind === 2) segments.push(`:p${index}`);
    else if (kind === 3) segments.push(`:p${index}{${pick(next, CONSTRAINTS)}}`);
    else if (kind === 4) segments.push('*');
    else segments.push(`:p${index}?`);
  }
  return segments.join('/');
}

// A request path shaped like `pattern` half the time, random otherwise.
function requestPath(next: () => number, pattern: string, prefix: string): string {
  const shaped = next() % 2 === 0;
  const segments = shaped
    ? pattern.split('/').flatMap((segment) => {
        if (!segment.startsWith(':') && segment !== '*') return [segment];
        if (segment.endsWith('?') && next() % 2 === 0) return [];
        const tail = segment === '*' ? Array.from({ length: next() % 3 }, () => '') : [''];
        return tail.map(() => pick(next, PATH_SEGMENTS));
      })
    : Array.from({ length: next() % 5 }, () => pick(next, PATH_SEGMENTS));
  const extra = next() % 4 === 0 ? [pick(next, PATH_SEGMENTS)] : [];
  const path = `${next() % 3 === 0 ? '' : prefix}/${[...segments, ...extra].join('/')}`;
  return next() % 5 === 0 ? `${path}/` : path;
}

let ran = false;
let reached = false;

@Injectable()
class FlagMiddleware implements NestMiddleware {
  async use(_c: Context, next: Next) {
    ran = true;
    await next();
  }
}

@Injectable()
class ReachedMiddleware implements NestMiddleware {
  async use(_c: Context, next: Next) {
    reached = true;
    await next();
  }
}

async function createApp(
  controllers: Type[],
  configure: (consumer: MiddlewareConsumer) => void,
  globalPrefix: string,
): Promise<VelaHono> {
  @Module({ providers: [FlagMiddleware, ReachedMiddleware], controllers })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      configure(consumer);
    }
  }
  const app = await VelaFactory.create(AppModule, { globalPrefix, diagnostics: 'silent' });
  return app.getHonoApp();
}

beforeEach(() => {
  MetadataRegistry.clear();
  ran = false;
});

describe('forRoutes(Controller) runs exactly when Hono dispatches to the controller', () => {
  it('agrees with the router for generated controllers and request paths', async () => {
    const next = seeded(0x7a11_2026);
    const decorators = [Get, Post, All] as const;
    let served: string | undefined;
    let samples = 0;

    for (let round = 0; round < 80; round += 1) {
      const prefix = pick(next, ['', '/api']);
      const controllers = Array.from({ length: 1 + (next() % 3) }, (_, index) => {
        const name = `C${index}`;
        const base = pick(next, ['', 'a', 'users', ':owner']);
        const [one, two, three] = Array.from({ length: 3 }, () => ({
          method: pick(next, decorators),
          path: routePattern(next),
        }));

        @Controller(base)
        class GeneratedController {
          @(one!.method(one!.path))
          one() {
            served = name;
            return { ok: true };
          }

          @(two!.method(two!.path))
          two() {
            served = name;
            return { ok: true };
          }

          @(three!.method(three!.path))
          three() {
            served = name;
            return { ok: true };
          }
        }
        return { name, controller: GeneratedController, pattern: `${base}/${one!.path}` };
      });
      const target = pick(next, controllers);
      const hono = await createApp(
        controllers.map(({ controller }) => controller),
        (consumer) => {
          consumer.apply(FlagMiddleware).forRoutes(target.controller);
        },
        prefix,
      );

      for (let request = 0; request < 30; request += 1) {
        const pattern = pick(next, controllers).pattern;
        const path = requestPath(next, pattern, prefix);
        const method = pick(next, REQUEST_METHODS);
        ran = false;
        served = undefined;
        await hono.request(path, { method });
        expect({ method, path, ran }).toEqual({ method, path, ran: served === target.name });
        samples += 1;
      }
    }
    expect(samples).toBe(2400);
  });
});

describe('string targets match the paths Hono matches for the same pattern', () => {
  // Parameter routes one to six segments deep: Hono's default router only runs
  // middleware for a path with a line terminator when a route matches it.
  @Controller()
  class ParamsController {
    @All(':a')
    one() {
      return { ok: true };
    }

    @All(':a/:b')
    two() {
      return { ok: true };
    }

    @All(':a/:b/:c')
    three() {
      return { ok: true };
    }

    @All(':a/:b/:c/:d')
    four() {
      return { ok: true };
    }

    @All(':a/:b/:c/:d/:e')
    five() {
      return { ok: true };
    }

    @All(':a/:b/:c/:d/:e/:f')
    six() {
      return { ok: true };
    }
  }

  // The Hono pattern for what a Vela target covers: forRoutes() also covers
  // the paths beneath the target, exclude() is exact.
  function referencePattern(target: string, prefix: string, descendants: boolean): string {
    if (target === '*') return '*';
    const resolved = `${prefix}/${target}`;
    if (!descendants || target.endsWith('*')) return resolved;
    return `${resolved.replace(/\/:[^/]+\?$/, '')}/*`;
  }

  // The reference is Hono's trie router, which matches middleware against the
  // request path itself; the default router decides per registered route and
  // runs no middleware at all for a path no route matches.
  it('agrees with Hono app.on() for generated targets and request paths', async () => {
    const next = seeded(0x5eed_0bad);
    let compared = 0;
    let terminators = 0;

    for (let round = 0; round < 60; round += 1) {
      const prefix = pick(next, ['', '/api']);
      const target = next() % 10 === 0 ? '*' : routePattern(next);
      const method = pick(next, [undefined, HttpMethod.GET, HttpMethod.POST]);
      const exclude = next() % 2 === 0;
      const route: RouteInfo = { path: target, ...(method ? { method } : {}) };

      const hono = await createApp(
        [ParamsController],
        (consumer) => {
          consumer.apply(ReachedMiddleware).forRoutes('*');
          if (exclude) consumer.apply(FlagMiddleware).exclude(route).forRoutes('*');
          else consumer.apply(FlagMiddleware).forRoutes(route);
        },
        prefix,
      );
      let matched = false;
      const reference = new Hono({ router: new TrieRouter() });
      reference.on(method ?? 'ALL', referencePattern(target, prefix, !exclude), (_c, next) => {
        matched = true;
        return next();
      });

      for (let request = 0; request < 40; request += 1) {
        const path = requestPath(next, target, prefix);
        const requestMethod = pick(next, REQUEST_METHODS);
        ran = false;
        reached = false;
        matched = false;
        await hono.request(path, { method: requestMethod });
        if (!reached) continue;
        await reference.request(path, { method: requestMethod });
        expect({ target, method, exclude, requestMethod, path, ran }).toEqual({
          target,
          method,
          exclude,
          requestMethod,
          path,
          ran: exclude ? !matched : matched,
        });
        compared += 1;
        if (/%0A|%0D|%E2%80%A[89]/.test(path)) terminators += 1;
      }
    }
    expect(compared).toBeGreaterThan(1500);
    expect(terminators).toBeGreaterThan(200);
  });
});
