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
const CONSTRAINTS = ['[0-9]+', '[a-z]+', '[a-z0-9]{2}', '[0-9]+|me'] as const;
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
// a trailing '*' or optional ':param?'; with `wildcards`, also a '*' before the
// last segment.
function routePattern(next: () => number, wildcards = false): string {
  const count = 1 + (next() % 3);
  const segments: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const kind = next() % (last ? 6 : wildcards ? 5 : 4);
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

// The Hono patterns Vela registers for a target: exclude() matches its
// pattern exactly; forRoutes() matches the pattern itself and the paths
// beneath it, which Hono writes as a trailing '*' and as a parameter that its
// RegExpRouter cannot hold beside a deeper route.
function referencePatterns(target: string, prefix: string, descendants: boolean): string[] {
  if (target === '*') return ['*'];
  const resolved = `${prefix}/${target}`;
  if (!descendants) return [resolved];
  const parent = resolved.replace(/\/(?::[^/]+\?|\*)?$/, '');
  return [...new Set([resolved, `${parent}/*`, `${parent}/:_{[^]+}`])];
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

describe('string targets match what Hono dispatches their patterns for', () => {
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

  // A literal beside ':a' makes Hono fall back from its RegExpRouter to its
  // TrieRouter.
  @Controller()
  class TrieOnlyController {
    @All('trie-only')
    fixed() {
      return { ok: true };
    }
  }

  const PARAM_ROUTES = [
    ':a',
    ':a/:b',
    ':a/:b/:c',
    ':a/:b/:c/:d',
    ':a/:b/:c/:d/:e',
    ':a/:b/:c/:d/:e/:f',
  ];
  // How a parent mounts the app, and the bases requests arrive with.
  const MOUNTS: ReadonlyArray<readonly [string | undefined, readonly string[]]> = [
    [undefined, ['']],
    ['/m', ['/m']],
    ['/m/', ['/m']],
    ['/:tenant', ['/t', '/a', '/users']],
    ['/:tenant{[a-z0-9-]+}', ['/t', '/a', '/users', '/A']],
  ];
  // The routes each app serves: only the target's own route (Hono keeps its
  // RegExpRouter unless a pattern conflicts), the parameter routes beside it,
  // or both plus a route that forces the TrieRouter.
  const ROUTE_SETS = ['target', 'params', 'trie'] as const;

  let served = false;

  it('agrees with a Hono app on the same router for generated targets, mounts and paths', async () => {
    const next = seeded(0x5eed_0bad);
    let compared = 0;
    let terminators = 0;
    let mounted = 0;
    let servedByTarget = 0;
    let checkedOnTrie = 0;
    const routers = new Map<string, number>();

    for (let round = 0; round < 200; round += 1) {
      const prefix = pick(next, ['', '/api']);
      const target = next() % 10 === 0 ? '*' : routePattern(next, true);
      const method = pick(next, [undefined, HttpMethod.GET, HttpMethod.POST]);
      const exclude = next() % 2 === 0;
      const routeSet = pick(next, ROUTE_SETS);
      const [base, bases] = pick(next, MOUNTS);
      const route: RouteInfo = { path: target, ...(method ? { method } : {}) };

      @Controller()
      class TargetController {
        @All(target)
        serve() {
          served = true;
          return { ok: true };
        }
      }

      const controllers = [
        ...(routeSet === 'target' ? [] : [ParamsController]),
        ...(target === '*' ? [] : [TargetController]),
        ...(routeSet === 'trie' ? [TrieOnlyController] : []),
      ];
      const routes = [
        ...(routeSet === 'target' ? [] : PARAM_ROUTES),
        ...(target === '*' ? [] : [target]),
        ...(routeSet === 'trie' ? ['trie-only'] : []),
      ];
      const app = await createApp(
        controllers,
        (consumer) => {
          consumer.apply(ReachedMiddleware).forRoutes('*');
          if (exclude) consumer.apply(FlagMiddleware).exclude(route).forRoutes('*');
          else consumer.apply(FlagMiddleware).forRoutes(route);
        },
        prefix,
      );
      // The same registrations on plain Hono apps: one on Hono's default
      // router, and one on its TrieRouter, which matches every pattern against
      // the request path. Vela's own '*' middleware shapes the choice of router.
      const references = [false, true].map((trie) => {
        const create = () => (trie ? new Hono({ router: new TrieRouter() }) : new Hono());
        const reference = { app: create(), matched: false };
        reference.app.use('*', (_c, proceed) => proceed());
        for (const pattern of referencePatterns(target, prefix, !exclude)) {
          reference.app.on(method ?? 'ALL', pattern, (_c, proceed) => {
            reference.matched = true;
            return proceed();
          });
        }
        for (const path of routes)
          reference.app.all(`${prefix}/${path}`, (c) => c.json({ ok: true }));
        if (base !== undefined) reference.app = create().route(base, reference.app);
        return reference;
      });
      const [reference, trieReference] = references as [
        (typeof references)[number],
        (typeof references)[number],
      ];
      const hono = base === undefined ? app : new Hono().route(base, app);

      for (let request = 0; request < 30; request += 1) {
        const path = `${pick(next, bases)}${requestPath(next, target, prefix)}`;
        const requestMethod = pick(next, REQUEST_METHODS);
        ran = false;
        reached = false;
        served = false;
        const { status } = await hono.request(path, { method: requestMethod });
        const servedHere = served;
        for (const each of references) {
          each.matched = false;
          await each.app.request(path, { method: requestMethod });
        }
        if (!reached) continue;
        const sample = { target, method, exclude, routeSet, base, requestMethod, path };
        expect({ ...sample, ran }).toEqual({
          ...sample,
          ran: exclude ? !reference.matched : reference.matched,
        });
        // Whichever router the app ends up on, a request a route serves runs
        // the middleware whenever the TrieRouter says it must. (The default
        // RegExpRouter can leave an exclude() unapplied, which only runs it.)
        if (status === 200 && (exclude ? !trieReference.matched : trieReference.matched)) {
          expect({ ...sample, trie: true, ran }).toEqual({ ...sample, trie: true, ran: true });
          checkedOnTrie += 1;
        }
        // A request the target's own route serves is one the target matches.
        if (
          servedHere &&
          (!method || requestMethod === method || (requestMethod === 'HEAD' && method === 'GET'))
        ) {
          expect({ ...sample, ran }).toEqual({ ...sample, ran: !exclude });
          servedByTarget += 1;
        }
        compared += 1;
        if (base !== undefined) mounted += 1;
        if (/%0A|%0D|%E2%80%A[89]/.test(path)) terminators += 1;
      }
      expect({ target, routeSet, base, router: hono.router.name }).toEqual({
        target,
        routeSet,
        base,
        router: reference.app.router.name,
      });
      routers.set(hono.router.name, (routers.get(hono.router.name) ?? 0) + 1);
    }
    expect(compared).toBeGreaterThan(4000);
    expect(terminators).toBeGreaterThan(1000);
    expect(mounted).toBeGreaterThan(3000);
    expect(servedByTarget).toBeGreaterThan(120);
    expect(checkedOnTrie).toBeGreaterThan(500);
    expect(routers.get('SmartRouter + RegExpRouter')).toBeGreaterThan(50);
    expect(routers.get('SmartRouter + TrieRouter')).toBeGreaterThan(80);
  });
});
