import { afterEach, describe, expect, it } from 'vitest';
import {
  defineProvider,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  setTrustedRequestIdentity,
  UseGuards,
  UsePipes,
  UseInterceptors,
  UseFilters,
  VelaFactory,
  type CanActivate,
  type PipeTransform,
  type NestInterceptor,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type Type,
  type VelaApplication,
} from '@velajs/vela';
import { createSchema } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import {
  GraphqlModule,
  GraphqlLoader,
  GraphqlClientError,
  bindResolver,
  type GraphqlContext,
  type GraphqlOptions,
  type GraphqlResolverContext,
} from '../index';
import { yogaDriver } from '../yoga';

const apps: VelaApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.dispose()));
});

async function application(
  options: Omit<GraphqlOptions, 'driver'> & { driver?: GraphqlOptions['driver'] },
  providers: Type[] = [],
  imports: (Type | DynamicModule)[] = [],
) {
  class App {}
  Module({
    providers,
    imports: [
      ...imports,
      GraphqlModule.forRoot({ ...options, driver: options.driver ?? yogaDriver() }),
    ],
  })(App);
  const app = await VelaFactory.create(App, { diagnostics: 'silent' });
  apps.push(app);
  return app;
}

function post(
  app: VelaApplication,
  query: string,
  variables?: Record<string, unknown>,
  path = '/graphql',
) {
  return app.getHonoApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

describe('GraphQL adapter', () => {
  it('runs asynchronous field pipes once, intercepts invocation and lets filters return field data', async () => {
    const events: string[] = [];
    class Pipe implements PipeTransform {
      transform(): never {
        throw new Error('sync entry must not run');
      }
      async transformAsync(value: unknown) {
        events.push('pipe');
        await Promise.resolve();
        return value;
      }
    }
    class Interceptor implements NestInterceptor {
      async intercept(_context: ExecutionContext, next: CallHandler) {
        events.push('before');
        try {
          return await next.handle();
        } finally {
          events.push('after');
        }
      }
    }
    class Filter {
      catch() {
        events.push('filter');
        return 'recovered';
      }
    }
    class Resolver {
      value(args: { value: string }) {
        events.push('handler');
        return args.value;
      }
    }
    for (const provider of [Pipe, Interceptor, Filter, Resolver]) Injectable()(provider);
    UsePipes(Pipe)(Resolver.prototype, 'value');
    UseInterceptors(Interceptor)(Resolver.prototype, 'value');
    UseFilters(Filter)(Resolver.prototype, 'value');
    const app = await application(
      {
        schema: createSchema<GraphqlContext>({
          typeDefs: 'type Query { value(value: String!): String! }',
          resolvers: {
            Query: {
              value: bindResolver(Resolver, 'value', {
                args: z.object({
                  value: z
                    .string()
                    .min(2)
                    .transform(async (value) => {
                      events.push('parse');
                      return value;
                    }),
                }),
              }),
            },
          },
        }),
      },
      [Resolver, Pipe, Interceptor, Filter],
    );
    expect(await (await post(app, '{ value(value:"ok") }')).json()).toEqual({
      data: { value: 'ok' },
    });
    expect(events).toEqual(['pipe', 'parse', 'before', 'handler', 'after']);
    events.length = 0;
    expect(await (await post(app, '{ value(value:"") }')).json()).toEqual({
      data: { value: 'recovered' },
    });
    expect(events).toEqual(['pipe', 'filter']);
  });
  it('uses actual constructors/private state, transforms arguments/output once and isolates request providers', async () => {
    let created = 0,
      parsed = 0,
      projected = 0;
    class Resolver {
      #id = ++created;
      echo(args: { count: number }) {
        return { value: args.count + this.#id };
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    const args = z.object({
      count: z.string().transform(async (value) => {
        parsed++;
        return Number(value);
      }),
    });
    const output = z.object({ value: z.number() }).transform(async (value) => {
      projected++;
      return String(value.value);
    });
    const schema = createSchema<GraphqlContext>({
      typeDefs: 'type Query { echo(count: String!): String! }',
      resolvers: { Query: { echo: bindResolver(Resolver, 'echo', { args, output }) } },
    });
    const app = await application({ schema }, [Resolver]);
    const first = await post(app, '{ a: echo(count:"10") b: echo(count:"20") }');
    expect(await first.json()).toEqual({ data: { a: '11', b: '21' } });
    expect(await (await post(app, '{ echo(count:"10") }')).json()).toEqual({
      data: { echo: '12' },
    });
    expect({ created, parsed, projected }).toEqual({ created: 2, parsed: 3, projected: 3 });
  });

  it('runs field guards before resolver construction with immutable alias-specific context', async () => {
    let created = 0;
    const paths: string[] = [];
    class Resolver {
      constructor() {
        created++;
      }
      value() {
        return 'visible';
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    class Guard implements CanActivate {
      async canActivate(context: ExecutionContext) {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.getType()).toBe('graphql');
        paths.push(context.getHandler().toString());
        await Promise.resolve();
        return false;
      }
    }
    Injectable()(Guard);
    UseGuards(Guard)(Resolver.prototype, 'value');
    const schema = createSchema<GraphqlContext>({
      typeDefs: 'type Query { value: String }',
      resolvers: { Query: { value: bindResolver(Resolver, 'value', { args: z.object({}) }) } },
    });
    const app = await application({ schema }, [Resolver, Guard]);
    const result = await (await post(app, '{ a:value b:value }')).json();
    expect(result).toMatchObject({
      data: { a: null, b: null },
      errors: [{ extensions: { code: 'FORBIDDEN' } }, { extensions: { code: 'FORBIDDEN' } }],
    });
    expect(created).toBe(0);
    expect(paths).toEqual(['value', 'value']);
  });

  it('deduplicates concurrent schema initialization per application, retries failed construction', async () => {
    let creates = 0;
    const schema = createSchema({
      typeDefs: 'type Query { hello: String! }',
      resolvers: { Query: { hello: () => 'world' } },
    });
    const options = {
      schema: async () => {
        creates++;
        await Promise.resolve();
        return schema;
      },
    };
    const a = await application(options),
      b = await application(options);
    await Promise.all([post(a, '{ hello }'), post(a, '{ hello }'), post(b, '{ hello }')]);
    expect(creates).toBe(2);
    let attempts = 0;
    const c = await application({
      schema: () => {
        if (++attempts === 1) throw new Error('retry');
        return schema;
      },
    });
    expect((await post(c, '{ hello }')).status).toBe(500);
    expect(await (await post(c, '{ hello }')).json()).toEqual({ data: { hello: 'world' } });
    expect(attempts).toBe(2);
  });

  it('shares loaders between sibling fields only inside one operation and cleans them after settling', async () => {
    let made = 0;
    const disposed: number[] = [];
    const loader = new GraphqlLoader(
      async () => ({ id: ++made }),
      (value) => {
        disposed.push(value.id);
      },
    );
    let captured: GraphqlResolverContext | undefined;
    class Resolver {
      async value(_args: object, context: GraphqlResolverContext) {
        captured = context;
        return (await context.operation.loader(loader)).id;
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    const app = await application(
      {
        schema: createSchema<GraphqlContext>({
          typeDefs: 'type Query { value: Int! }',
          resolvers: { Query: { value: bindResolver(Resolver, 'value', { args: z.object({}) }) } },
        }),
      },
      [Resolver],
    );
    expect(await (await post(app, '{ a:value b:value }')).json()).toEqual({ data: { a: 1, b: 1 } });
    expect(await (await post(app, '{ value }')).json()).toEqual({ data: { value: 2 } });
    expect(disposed).toEqual([1, 2]);
    expect(() => captured?.operation.loader(loader)).toThrow('finished');
  });

  it('waits for siblings after a non-null failure before closing operation resources', async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = new GraphqlLoader(
      () => 'resource',
      () => {
        events.push('disposed');
      },
    );
    const app = await application({
      schema: createSchema<GraphqlContext>({
        typeDefs: 'type Query { fail: String! slow: String }',
        resolvers: {
          Query: {
            fail: () => {
              throw new Error('secret');
            },
            slow: async (_root: unknown, _args: unknown, context: GraphqlContext) => {
              await gate;
              await context.operation.loader(loader);
              events.push('settled');
              return 'done';
            },
          },
        },
      }),
    });
    const pending = post(app, '{ fail slow }');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
    release?.();
    const result = await (await pending).json();
    expect(events).toEqual(['settled', 'disposed']);
    expect(result).toMatchObject({ data: null, errors: [{ message: 'Unexpected error' }] });
  });

  it('maps validation and internal output errors without exposing arbitrary extensions or secrets', async () => {
    class Resolver {
      input(args: { age: number }) {
        return args.age;
      }
      output() {
        return 'not-a-number';
      }
      fail() {
        throw new Error('db password=secret');
      }
    }
    Injectable()(Resolver);
    const schema = createSchema<GraphqlContext>({
      typeDefs: 'type Query { input(age:Int!):Int output:Int fail:String }',
      resolvers: {
        Query: {
          input: bindResolver(Resolver, 'input', { args: z.object({ age: z.number().min(18) }) }),
          output: bindResolver(Resolver, 'output', { args: z.object({}), output: z.number() }),
          fail: bindResolver(Resolver, 'fail', { args: z.object({}) }),
        },
      },
    });
    const app = await application({ schema }, [Resolver]);
    const text = await (await post(app, '{ input(age:1) output fail }')).text();
    expect(text).not.toContain('password');
    expect(JSON.parse(text)).toMatchObject({
      errors: [
        { extensions: { code: 'BAD_USER_INPUT' } },
        { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
      ],
    });
  });

  it('rejects unsupported protocols, oversized bodies and expanded fragment budgets', async () => {
    const schema = createSchema({
      typeDefs: 'type Query { value: String } type Subscription { value: String }',
      resolvers: { Query: { value: () => 'ok' } },
    });
    const app = await application({
      schema,
      driver: yogaDriver({ maxRequestBytes: 256, maxFields: 2 }),
    });
    expect((await app.getHonoApp().request('/graphql')).status).toBe(405);
    expect(
      (await app.getHonoApp().request('/graphql', { method: 'POST', body: 'query { value }' }))
        .status,
    ).toBe(415);
    expect(
      (
        await app.getHonoApp().request('/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '[{"query":"{value}"},{"query":"{value}"}]',
        })
      ).status,
    ).toBe(400);
    expect((await post(app, '{ value }', { huge: 'x'.repeat(300) })).status).toBe(413);
    expect(await (await post(app, 'subscription { value }')).json()).toHaveProperty('errors');
    expect(
      await (
        await post(app, 'query { ...A } fragment A on Query { a:value b:value c:value }')
      ).json(),
    ).toHaveProperty('errors');
    expect(await (await post(app, '{ __schema { queryType { name } } }')).json()).toHaveProperty(
      'errors',
    );
  });

  it('resolves async dependencies and keeps loader authority bound to the verified request', async () => {
    const VALUE = new InjectionToken<string>('async.value');
    class Resolver {
      readonly #value: string;
      constructor(value: string) {
        this.#value = value;
      }
      value() {
        return this.#value;
      }
      replace(_args: object, context: GraphqlResolverContext) {
        setTrustedRequestIdentity(context.request, {
          principal: { issuer: 'test', subject: 'other', principalType: 'user' },
        });
        return 'hidden';
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    Inject(VALUE)(Resolver, undefined, 0);
    class Feature {}
    Module({
      providers: [
        Resolver,
        defineProvider(VALUE, {
          scope: Scope.REQUEST,
          useFactory: async () => 'awaited',
        }),
      ],
    })(Feature);
    const schema = createSchema<GraphqlContext>({
      typeDefs: 'type Query { value:String replace:String }',
      resolvers: {
        Query: {
          value: bindResolver(Resolver, 'value', { args: z.object({}) }),
          replace: bindResolver(Resolver, 'replace', { args: z.object({}) }),
        },
      },
    });
    const app = await application({ schema }, [], [Feature]);
    expect(await (await post(app, '{ value }')).json()).toEqual({ data: { value: 'awaited' } });
    expect(await (await post(app, '{ replace }')).json()).toMatchObject({
      data: { replace: null },
      errors: [{ extensions: { code: 'FORBIDDEN' } }],
    });
  });

  it('keeps repeated resolver and guard registrations qualified to their exact module', async () => {
    const LABEL = new InjectionToken<string>('owner.label');
    const seen: string[] = [];
    class Guard implements CanActivate {
      constructor(readonly label: string) {}
      canActivate() {
        seen.push(this.label);
        return true;
      }
    }
    class Resolver {
      constructor(readonly label: string) {}
      value() {
        return this.label;
      }
    }
    for (const type of [Guard, Resolver]) {
      Injectable({ scope: Scope.REQUEST })(type);
      Inject(LABEL)(type, undefined, 0);
    }
    UseGuards(Guard)(Resolver.prototype, 'value');
    class Left {}
    class Right {}
    Module({ providers: [Resolver, Guard, defineProvider(LABEL, { useValue: 'left' })] })(Left);
    Module({ providers: [Resolver, Guard, defineProvider(LABEL, { useValue: 'right' })] })(Right);
    const app = await application(
      {
        schema: ({ discovery }) => {
          const owners = discovery
            .getRegistrations({ metadataOnly: true })
            .filter((hit) => hit.token === Resolver);
          expect(owners).toHaveLength(2);
          return createSchema<GraphqlContext>({
            typeDefs: 'type Query { left:String right:String ambiguous:String }',
            resolvers: {
              Query: {
                left: bindResolver(Resolver, 'value', {
                  args: z.object({}),
                  moduleId: owners[0]!.moduleId,
                }),
                right: bindResolver(Resolver, 'value', {
                  args: z.object({}),
                  moduleId: owners[1]!.moduleId,
                }),
                ambiguous: bindResolver(Resolver, 'value', { args: z.object({}) }),
              },
            },
          });
        },
      },
      [],
      [Left, Right],
    );
    expect(await (await post(app, '{ left right }')).json()).toEqual({
      data: { left: 'left', right: 'right' },
    });
    expect(seen.sort()).toEqual(['left', 'right']);
    expect(await (await post(app, '{ ambiguous }')).json()).toMatchObject({
      data: { ambiguous: null },
      errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
    });
  });

  it('keeps mutation cache invalidation explicit and executes roots serially', async () => {
    let current = 'before';
    const loader = new GraphqlLoader(() => new Map<string, string>());
    class Resolver {
      async update(args: { value: string }, context: GraphqlResolverContext) {
        const cache = await context.operation.loader(loader);
        const previous = cache.get('value') ?? current;
        current = args.value;
        cache.clear();
        cache.set('value', current);
        return `${previous}->${current}`;
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    const schema = createSchema<GraphqlContext>({
      typeDefs: 'type Query { value: String } type Mutation { update(value:String!):String! }',
      resolvers: {
        Query: { value: () => current },
        Mutation: {
          update: bindResolver(Resolver, 'update', { args: z.object({ value: z.string() }) }),
        },
      },
    });
    const original = schema.getMutationType()!.getFields().update!.resolve;
    const app = await application({ schema }, [Resolver]);
    expect(
      await (
        await post(app, 'mutation { a:update(value:"middle") b:update(value:"after") }')
      ).json(),
    ).toEqual({ data: { a: 'before->middle', b: 'middle->after' } });
    expect(schema.getMutationType()!.getFields().update!.resolve).toBe(original);
  });

  it('passes cancellation to running resolvers and drains cleanup before completing', async () => {
    const events: string[] = [];
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const loader = new GraphqlLoader(
      () => 'value',
      () => {
        events.push('dispose');
      },
    );
    class Resolver {
      async wait(_args: object, context: GraphqlResolverContext) {
        await context.operation.loader(loader);
        enter?.();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        events.push('abort');
        return 'never exposed';
      }
    }
    Injectable({ scope: Scope.REQUEST })(Resolver);
    const app = await application(
      {
        schema: createSchema<GraphqlContext>({
          typeDefs: 'type Query { wait: String }',
          resolvers: {
            Query: {
              wait: bindResolver(Resolver, 'wait', { args: z.object({}) }),
            },
          },
        }),
      },
      [Resolver],
    );
    const controller = new AbortController();
    const pending = app.getHonoApp().fetch(
      new Request('https://example.test/graphql', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ wait }' }),
      }),
    );
    await entered;
    controller.abort();
    const response = await pending;
    expect(await response.text()).not.toContain('never exposed');
    expect(events).toEqual(['abort', 'dispose']);
  });

  it('bounds public error messages/counts and masks arbitrary resolver GraphQLError extensions', async () => {
    const app = await application({
      schema: createSchema<GraphqlContext>({
        typeDefs: 'type Query { expected: String unexpected:String }',
        resolvers: {
          Query: {
            expected: () => {
              throw new GraphqlClientError('BAD_USER_INPUT', 'x'.repeat(1000));
            },
            unexpected: () => {
              throw new GraphQLError('secret', { extensions: { password: 'secret' } });
            },
          },
        },
      }),
    });
    const response = await post(
      app,
      `{ ${Array.from({ length: 12 }, (_, i) => `a${i}:expected`).join(' ')} }`,
    );
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors).toHaveLength(10);
    expect(body.errors.every((error) => error.message.length === 512)).toBe(true);
    expect(
      (await post(app, '{ unexpected }')).headers.get('access-control-allow-origin'),
    ).toBeNull();
    expect(await (await post(app, '{ unexpected }')).text()).not.toContain('secret');
  });

  it('disposes the initialized server exactly once with the application', async () => {
    let disposed = 0;
    const app = await application({
      schema: createSchema({ typeDefs: 'type Query { value:String }' }),
      driver: {
        create: () => ({
          handle: async () => Response.json({ data: { value: 'ok' } }),
          dispose: () => {
            disposed++;
          },
        }),
      },
    });
    await (await post(app, '{ value }')).text();
    await app.dispose();
    await app.dispose();
    expect(disposed).toBe(1);
  });
});
