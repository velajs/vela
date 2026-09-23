import { beforeEach, describe, expect, it } from 'vitest';
import { Hono, type Context, type Env, type Next } from 'hono';
import { LinearRouter } from 'hono/router/linear-router';
import { RegExpRouter } from 'hono/router/reg-exp-router';
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
  type VelaHonoEnv,
} from '../index';

// Differential property sweep for consumer middleware: a seeded generator
// builds targets, routes, mounts and request paths, and every sample compares
// Vela's decision with Hono's own dispatch. A mismatch where Vela skips the
// middleware is a fail-open.

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

const LITERALS = ['a', 'b', 'users', 'v1', 'v1.0', 'a+b', 'é'] as const;
const CONSTRAINTS = ['[0-9]+', '[a-z]+', '[a-z0-9]{2}', '[0-9]+|me'] as const;
// Request segments: route literals in other cases, parameter values, an empty
// segment, unicode, every line terminator Hono decodes into c.req.path,
// escapes that decoding keeps or changes, and a long one.
const PATH_SEGMENTS = [
  ...LITERALS,
  'A',
  'V1',
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
  '%61',
  '%3A',
  '%25',
  'a'.repeat(2048),
] as const;
const REQUEST_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE', 'ALL'] as const;

// A route pattern in Hono syntax: static text, ':param', ':param{regex}', and
// a trailing '*' or optional ':param?'.
function routePattern(next: () => number): string {
  const count = 1 + (next() % 3);
  const segments: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = next() % (index === count - 1 ? 6 : 4);
    if (kind < 2) segments.push(pick(next, LITERALS));
    else if (kind === 2) segments.push(`:p${index}`);
    else if (kind === 3) segments.push(`:p${index}{${pick(next, CONSTRAINTS)}}`);
    else if (kind === 4) segments.push('*');
    else segments.push(`:p${index}?`);
  }
  return segments.join('/');
}

// A target in the middleware grammar: up to three literal or ':param'
// segments, then a trailing wildcard, a trailing slash or nothing.
const TAILS = ['', '', '', '/', '*', '*rest', '{*rest}', '(.*)'] as const;
function targetPattern(next: () => number): string {
  const segments = Array.from({ length: next() % 4 }, (_, index) =>
    next() % 3 === 0 ? `:p${index}` : pick(next, LITERALS),
  );
  const tail = pick(next, TAILS);
  const path =
    tail === '/' ? `${segments.join('/')}/` : [...segments, ...(tail ? [tail] : [])].join('/');
  return next() % 2 === 0 && !path.startsWith('/') ? `/${path}` : path;
}

// '*', '/*' and '{*name}' alone match every path, never under the prefix,
// and so does '(.*)' in forRoutes(), which Nest 11 reads as '{*path}'.
const EVERY_PATH = /^\/?(?:\*|\{\*\w+\})$/;
const EVERY_PATH_FOR_ROUTES = /^\/?(?:\*|\{\*\w+\}|\(\.\*\))$/;

// A request path shaped like `pattern` half the time, random otherwise.
function requestPath(next: () => number, pattern: string, prefix: string): string {
  const shaped = next() % 2 === 0;
  const segments = shaped
    ? pattern.split('/').flatMap((segment) => {
        if (!/^[:*({]/.test(segment)) return [segment];
        if (segment.endsWith('?') && next() % 2 === 0) return [];
        const count = /^[*({]/.test(segment) ? next() % 3 : 1;
        return Array.from({ length: count }, () => pick(next, PATH_SEGMENTS));
      })
    : Array.from({ length: next() % 5 }, () => pick(next, PATH_SEGMENTS));
  const extra = next() % 4 === 0 ? [pick(next, PATH_SEGMENTS)] : [];
  const path = `${next() % 3 === 0 ? '' : prefix}/${[...segments, ...extra].join('/')}`;
  return next() % 5 === 0 ? `${path}/` : path;
}

// The Hono patterns whose dispatch a target means. An exact target is its
// own pattern, with the global prefix joined as routes join it. A trailing
// '*' or '{*name}' covers the parent path and every path beneath it, a
// trailing '*name' one or more characters beneath it, and a forRoutes()
// target also covers the paths beneath it. A trailing '(.*)' is '{*name}' in
// forRoutes(), as Nest 11 reads it, and '*name' in exclude(). Hono's
// RegExpRouter stops a trailing '*' at a decoded line terminator, while its
// TrieRouter does not, so the paths beneath are also written ':rest{[\s\S]+}'.
function referencePatterns(target: string, prefix: string, descendants: boolean): string[] {
  const written = `${prefix.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
  const tail = /\/(?:\*|\{\*rest\})$/.test(written)
    ? '*'
    : /\/(?:\*rest|\(\.\*\))$/.test(written)
      ? descendants && written.endsWith('(.*)')
        ? '*'
        : '+'
      : descendants
        ? '*'
        : '';
  const parent = tail ? written.replace(/\/(?:\*|\{\*rest\}|\*rest|\(\.\*\))?$/, '') : written;
  const beneath = `${parent}/:rest{[\\s\\S]+}`;
  if (tail === '+') return [beneath];
  if (tail === '*') return [`${parent}/*`, beneath];
  return [parent];
}

// Hono's LinearRouter serves ':name' on an empty segment, so a forRoutes()
// ':name' segment also matches one. Its reference therefore reads each empty
// segment of the request path that lines up with a target parameter, beneath
// the base and the global prefix, as a value. A base that ends in '/', like
// the root, is the app's root itself, not an empty segment beneath it.
function fillParameters(path: string, base: string, prefix: string, target: string): string {
  if (path === base || path === '/') return path;
  const skip = `${base}/${prefix}`.split('/').filter(Boolean).length;
  const parameters = target.replace(/^\//, '').split('/');
  return path
    .split('/')
    .map((segment, index) =>
      !segment && parameters[index - 1 - skip]?.startsWith(':') ? '_' : segment,
    )
    .join('/');
}

function methodReaches(method: string, target: string | undefined): boolean {
  return (
    target === undefined ||
    target === HttpMethod.ALL ||
    target === method ||
    (method === 'HEAD' && target === HttpMethod.GET)
  );
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

describe('path targets decide as Hono dispatches their patterns on every router', () => {
  // Parameter routes one to six segments deep, some under URI versions.
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

    @All(':a/:b/:c/:d/:e/:f')
    six() {
      return { ok: true };
    }
  }

  @Controller({ path: 'users', version: [1, 2] })
  class VersionedController {
    @All(':id/:rest')
    one() {
      return { ok: true };
    }
  }

  // A literal beside ':a' makes Hono fall back from its RegExpRouter to its
  // TrieRouter, and a catch-all serves every other path.
  @Controller()
  class TrieOnlyController {
    @All('trie-only')
    fixed() {
      return { ok: true };
    }

    @All('*')
    any() {
      return { ok: true };
    }
  }

  // How parents mount the app, and the bases requests arrive with: a base
  // that ends in '/' puts the app's root beneath it, and a decoded parameter
  // does not spell its path, so the middleware runs for those requests. A
  // parent on the LinearRouter serves ':name' routes on empty segments, and a
  // base parameter whose '{regex}' can span '/' makes every request fail closed.
  const MOUNTS: ReadonlyArray<
    readonly [readonly string[], readonly string[], (() => Hono<VelaHonoEnv>)?]
  > = [
    [[], ['']],
    [['/m'], ['/m']],
    [['/m'], ['/m'], () => new Hono<VelaHonoEnv>({ router: new LinearRouter() })],
    [['/:tenant{.+}'], ['/t', '/a/b']],
    [['/m/'], ['/m/', '/m']],
    [['/:tenant'], ['/t', '/users', '/a%3Ab', '/x%25y']],
    [['/:tenant{[a-z0-9-]+}'], ['/t', '/users', '/A', '/auth']],
    [['/:t/'], ['/t/', '/t']],
    [
      ['/o', '/:t'],
      ['/o/t', '/o/users', '/o/a%3Ab'],
    ],
  ];
  const ROUTE_SETS = ['params', 'versioned', 'trie'] as const;
  const TARGET_METHODS = [undefined, HttpMethod.GET, HttpMethod.POST, 'OPTIONS', 'ALL'] as const;

  function mount<E extends Env>(
    app: Hono<E>,
    bases: readonly string[],
    create: () => Hono<E>,
  ): Hono<E> {
    const [base, ...rest] = bases;
    return base === undefined ? app : create().route(base, mount(app, rest, create));
  }

  it('agrees with Hono on the RegExpRouter and the TrieRouter', async () => {
    const next = seeded(0x5eed_0bad);
    let compared = 0;
    let terminators = 0;
    let mounted = 0;
    let failedClosed = 0;
    let absolute = 0;
    let emptyParameters = 0;
    let spanned = 0;
    const routers = new Map<string, number>();

    for (let round = 0; round < 240; round += 1) {
      const prefix = pick(next, ['', '/api']);
      const target = next() % 12 === 0 ? pick(next, ['*', '/*', '{*splat}']) : targetPattern(next);
      const method = pick(next, TARGET_METHODS);
      const isAbsolute = !EVERY_PATH.test(target) && next() % 4 === 0;
      const exclude = next() % 2 === 0;
      const everyPath = (exclude ? EVERY_PATH : EVERY_PATH_FOR_ROUTES).test(target);
      const routeSet = pick(next, ROUTE_SETS);
      const [bases, requestBases, createParent = () => new Hono<VelaHonoEnv>()] = pick(
        next,
        MOUNTS,
      );
      const spans = bases.some((base) => base.includes('{.+}'));
      const route: RouteInfo = {
        path: target,
        ...(method ? { method } : {}),
        ...(isAbsolute ? { absolute: true } : {}),
      };
      const controllers = [
        routeSet === 'versioned' ? VersionedController : ParamsController,
        ...(routeSet === 'trie' ? [TrieOnlyController] : []),
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
      const hono = mount(app, bases, createParent);

      // The target's patterns alone, on each of Hono's routers.
      const patterns = everyPath
        ? []
        : referencePatterns(target, isAbsolute ? '' : prefix, !exclude);
      // Hono's TrieRouter reads the literal after a constrained parameter as a
      // regular expression, so it misses '/auth/a+b' under
      // '/:tenant{[a-z0-9-]+}'. That is the mount base's syntax, not the
      // target's, so only the RegExpRouter speaks for those paths.
      const trieMisreads =
        bases.some((base) => base.includes('{')) &&
        patterns.some((pattern) => /^\/[^/]*\+/.test(pattern));
      const references = [
        () => new Hono({ router: new RegExpRouter() }),
        () => new Hono({ router: new TrieRouter() }),
      ].map((create) => {
        const reference = { app: create(), matched: false };
        for (const pattern of patterns) {
          reference.app.on(method ?? 'ALL', pattern, (c) => {
            reference.matched = true;
            return c.body(null, 204);
          });
        }
        reference.app = mount(reference.app, bases, create);
        return reference;
      });

      for (let request = 0; request < 30; request += 1) {
        const base = pick(next, requestBases);
        const relative = requestPath(next, target, isAbsolute ? '' : prefix);
        const path =
          next() % 16 === 0 && bases.length ? base : `${base.replace(/\/$/, '')}${relative}`;
        const requestMethod = pick(next, REQUEST_METHODS);
        ran = false;
        reached = false;
        await hono.request(path, { method: requestMethod });
        for (const reference of spans ? [] : references) {
          reference.matched = false;
          await reference.app.request(path, { method: requestMethod });
        }
        const [onRegExp, onTrie] = references.map((reference) => reference.matched);
        const sample = { target, method, isAbsolute, exclude, bases, requestMethod, path };
        // Both routers read the reference patterns alike: each spells a trailing
        // wildcard the RegExpRouter's way and the TrieRouter's way.
        if (!trieMisreads && !spans) {
          expect({ ...sample, onRegExp }).toEqual({ ...sample, onRegExp: onTrie });
        }
        if (!reached) continue;

        let onTarget = onRegExp;
        const filled = fillParameters(path, base, isAbsolute ? '' : prefix, target);
        if (!exclude && filled !== path) {
          references[0]!.matched = false;
          await references[0]!.app.request(filled, { method: requestMethod });
          onTarget = references[0]!.matched;
          if (onTarget !== onRegExp) emptyParameters += 1;
        }
        const failClosed =
          !everyPath &&
          (spans ||
            base.includes('%') ||
            (!!bases.at(-1)?.endsWith('/') && !path.startsWith(base.replace(/\/?$/, '/'))));
        const methodOk = methodReaches(requestMethod, method);
        const hit = everyPath ? methodOk : failClosed ? methodOk && !exclude : onTarget;
        expect({ ...sample, ran }).toEqual({ ...sample, ran: exclude ? !hit : hit });

        compared += 1;
        if (bases.length) mounted += 1;
        if (failClosed) failedClosed += 1;
        if (spans) spanned += 1;
        if (isAbsolute) absolute += 1;
        if (/%0A|%0D|%E2%80%A[89]/.test(path)) terminators += 1;
      }
      routers.set(hono.router.name, (routers.get(hono.router.name) ?? 0) + 1);
    }
    expect(compared).toBeGreaterThan(5000);
    expect(terminators).toBeGreaterThan(800);
    expect(mounted).toBeGreaterThan(4000);
    expect(failedClosed).toBeGreaterThan(500);
    expect(absolute).toBeGreaterThan(1000);
    expect(emptyParameters).toBeGreaterThan(20);
    expect(spanned).toBeGreaterThan(400);
    expect(routers.get('LinearRouter')).toBeGreaterThan(20);
    expect(routers.get('SmartRouter + RegExpRouter')).toBeGreaterThan(100);
    expect(routers.get('SmartRouter + TrieRouter')).toBeGreaterThan(60);
  });
});

// Vela matches targets segment by segment, so crafted paths cost time linear
// in their length: no pattern backtracks and no target joins Hono's routing.
describe('matching time is linear in the path length', () => {
  @Controller('/files')
  class FilesController {
    @Get(':a')
    one() {
      return { ok: true };
    }

    @Get('static')
    fixed() {
      return { ok: true };
    }
  }

  it('decides 16 KB crafted paths within 50 ms in total', async () => {
    const app = await createApp(
      [FilesController],
      (consumer) => {
        consumer
          .apply(FlagMiddleware)
          .exclude('files/:a/:b/:c/:d/x', 'files/:a/raw/*path', { path: 'files', absolute: true })
          .forRoutes('files', ':a/:b/:c/:d/x', 'files/*path', 'files/{*rest}', '(.*)');
      },
      '',
    );
    const hono = new Hono().route('/:tenant', app);
    const paths = [
      `/t${'/'.repeat(16 * 1024)}`,
      `/t/files${'/a'.repeat(8 * 1024)}`,
      `/t/files/${'a/'.repeat(8 * 1024)}y`,
      `/t/files/${'%0A/'.repeat(4 * 1024)}x`,
      `/t/${':a/'.repeat(5 * 1024)}`,
      `/${'t'.repeat(16 * 1024)}/files/1`,
    ];
    // Warm up the router and the application graph.
    await hono.request('/t/files/1');

    const startedAt = performance.now();
    for (const path of paths) await hono.request(path);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
