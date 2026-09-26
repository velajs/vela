import { afterEach, describe, expect, it } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  UseGuards,
  UsePipes,
  VelaFactory,
  defineProvider,
  type Type,
  type VelaApplication,
} from '@velajs/vela';
import { DiscoveryService } from '@velajs/vela/module-kit';
import { buildSchema, parse, type GraphQLResolveInfo } from 'graphql';
import { z } from 'zod';
import {
  Args,
  Context,
  GraphqlModule,
  Info,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  type GraphqlModuleOptions,
  type GraphqlResolverContext,
} from '../index';
import { decoratedSchema } from '../decorators';
import { yogaDriver } from '../yoga';

const apps: VelaApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.dispose()));
});

async function boot(root: Type) {
  const app = await VelaFactory.create(root, { diagnostics: 'throw' });
  apps.push(app);
  return app;
}

function field(target: Type, method: string, decorator: MethodDecorator) {
  decorator(target.prototype, method, Object.getOwnPropertyDescriptor(target.prototype, method)!);
}

async function post(app: VelaApplication, query: string, path = '/graphql') {
  const response = await app.getHonoApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return response.json();
}

describe('schema-first resolver decorators', () => {
  it('maps query, mutation and object fields through DI, pipes and validators', async () => {
    const events: string[] = [];
    let constructions = 0;
    class Items {
      readonly #prefix = 'item';
      constructor() {
        constructions++;
      }
      item(
        id: number,
        args: { id: number },
        context: GraphqlResolverContext,
        info: GraphQLResolveInfo,
      ) {
        events.push('invoke');
        expect(args).toEqual({ id });
        expect(context.info).toBe(info);
        expect(context.request).toBeInstanceOf(Request);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        return { id, prefix: this.#prefix };
      }
      label(parent: { id: number; prefix: string }) {
        return `${parent.prefix}:${parent.id}`;
      }
      rename(name: string) {
        return name;
      }
    }
    Resolver('Item')(Items);
    Injectable({ scope: Scope.REQUEST })(Items);
    field(
      Items,
      'item',
      Query(undefined, {
        args: z.object({ id: z.string() }).transform(({ id }) => {
          events.push('validate');
          return { id: Number(id) };
        }),
      }),
    );
    Args('id')(Items.prototype, 'item', 0);
    Args()(Items.prototype, 'item', 1);
    Context()(Items.prototype, 'item', 2);
    Info()(Items.prototype, 'item', 3);
    field(
      Items,
      'item',
      UsePipes({
        transform(value: unknown) {
          events.push('pipe');
          return value;
        },
      }),
    );
    field(
      Items,
      'label',
      ResolveField(undefined, { output: z.string().transform((value) => value.toUpperCase()) }),
    );
    Parent()(Items.prototype, 'label', 0);
    field(Items, 'rename', Mutation());
    Args('name')(Items.prototype, 'rename', 0);
    class App {}
    Module({
      providers: [Items],
      imports: [
        GraphqlModule.forRoot({
          typeDefs: parse(
            'type Query { item(id: ID!): Item! } type Item { label: String! } type Mutation { rename(name: String!): String! }',
          ),
          driver: yogaDriver(),
        }),
      ],
    })(App);
    const app = await boot(App);
    expect(constructions).toBe(0);
    expect(await post(app, '{ item(id: "12") { label } }')).toEqual({
      data: { item: { label: 'ITEM:12' } },
    });
    expect(events).toEqual(['pipe', 'validate', 'invoke']);
    expect(constructions).toBe(1);
    expect(await post(app, 'mutation { rename(name: "new") }')).toEqual({
      data: { rename: 'new' },
    });
    expect(constructions).toBe(2);
  });

  it('runs guards before constructing a request-scoped resolver', async () => {
    let created = 0;
    class Denied {
      constructor() {
        created++;
      }
      value() {
        return 'secret';
      }
    }
    Resolver()(Denied);
    Injectable({ scope: Scope.REQUEST })(Denied);
    field(Denied, 'value', Query());
    field(Denied, 'value', UseGuards({ canActivate: () => false }));
    class App {}
    Module({
      providers: [Denied],
      imports: [
        GraphqlModule.forRoot({
          typeDefs: 'type Query { value: String }',
          driver: yogaDriver(),
        }),
      ],
    })(App);
    const app = await boot(App);
    const result = await post(app, '{ value }');
    expect(result).toMatchObject({
      data: { value: null },
      errors: [{ extensions: { code: 'FORBIDDEN' } }],
    });
    expect(created).toBe(0);
  });

  it('selects declaring module owners per endpoint without widening to imports', async () => {
    const LABEL = new InjectionToken<string>('graphql endpoint label');
    class Greeting {
      constructor(readonly label: string) {}
      greet() {
        return this.label;
      }
    }
    Resolver()(Greeting);
    Inject(LABEL)(Greeting, undefined, 0);
    field(Greeting, 'greet', Query());
    class Left {}
    class Right {}
    Module({ providers: [Greeting, defineProvider(LABEL, { useValue: 'left' })] })(Left);
    Module({
      imports: [Left],
      providers: [Greeting, defineProvider(LABEL, { useValue: 'right' })],
    })(Right);
    class App {}
    Module({
      imports: [
        Right,
        ...[
          { path: '/left', include: [Left] },
          { path: '/right', include: [Right] },
          { path: '/none', include: [] },
          { path: '/provider', include: [Greeting] },
        ].map((selection) =>
          GraphqlModule.forRoot({
            ...selection,
            typeDefs: 'type Query { greet: String }',
            driver: yogaDriver(),
          }),
        ),
      ],
    })(App);
    const app = await boot(App);
    expect(await post(app, '{ greet }', '/left')).toEqual({ data: { greet: 'left' } });
    expect(await post(app, '{ greet }', '/right')).toEqual({ data: { greet: 'right' } });
    expect(await post(app, '{ greet }', '/none')).toEqual({ data: { greet: null } });
    expect(await post(app, '{ greet }', '/provider')).toEqual({ data: { greet: null } });
    expect(() =>
      decoratedSchema(
        'type Query { greet: String }',
        app.get(DiscoveryService),
        undefined,
        app.getContainer(),
      ),
    ).toThrow("Duplicate GraphQL resolver for 'Query.greet'");
  });

  it('discovers only each application and keeps executable schema mode independent', async () => {
    function root(value: string, executable = false) {
      class Greeting {
        greet() {
          return value;
        }
      }
      Resolver()(Greeting);
      field(Greeting, 'greet', Query());
      class App {}
      Module({
        providers: [Greeting],
        imports: [
          GraphqlModule.forRoot({
            ...(executable
              ? { schema: buildSchema('type Query { greet: String }') }
              : { typeDefs: 'type Query { greet: String }' }),
            driver: yogaDriver(),
          }),
        ],
      })(App);
      return App;
    }
    const [first, second, executable] = await Promise.all([
      boot(root('first')),
      boot(root('second')),
      boot(root('unused', true)),
    ]);
    expect(await post(first, '{ greet }')).toEqual({ data: { greet: 'first' } });
    expect(await post(second, '{ greet }')).toEqual({ data: { greet: 'second' } });
    expect(await post(executable, '{ greet }')).toEqual({ data: { greet: null } });
  });

  it('rejects mappings absent from SDL and missing Resolver type declarations', async () => {
    class Missing {
      missing() {}
    }
    Resolver()(Missing);
    field(Missing, 'missing', Query());
    class App {}
    Module({ providers: [Missing] })(App);
    const app = await boot(App);
    expect(() =>
      decoratedSchema(
        'type Query { value: String }',
        app.get(DiscoveryService),
        undefined,
        app.getContainer(),
      ),
    ).toThrow("GraphQL field 'Query.missing' is absent from the SDL");
    class Child {
      value() {}
    }
    Resolver()(Child);
    field(Child, 'value', ResolveField());
    class Other {}
    Module({ providers: [Child] })(Other);
    const other = await boot(Other);
    expect(() =>
      decoratedSchema(
        'type Query { value: String }',
        other.get(DiscoveryService),
        undefined,
        other.getContainer(),
      ),
    ).toThrow('has no field type');
  });

  it('rejects ambiguous runtime schema sources', async () => {
    class App {}
    const invalid = {
      schema: buildSchema('type Query { value: String }'),
      typeDefs: 'type Query { value: String }',
      driver: yogaDriver(),
    };
    Module({ imports: [GraphqlModule.forRoot(invalid as unknown as GraphqlModuleOptions)] })(App);
    await expect(boot(App)).rejects.toThrow('exactly one of schema or typeDefs');
  });
});
