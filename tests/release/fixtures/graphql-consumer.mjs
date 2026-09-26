import assert from 'node:assert/strict';
import { bindResolver, GraphqlLoader, GraphqlModule } from '@velajs/graphql';
import { yogaDriver } from '@velajs/graphql/yoga';
import { compareGraphqlSchema, printGraphqlSchema } from '@velajs/graphql/schema';
import { Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import { createSchema } from 'graphql-yoga';
import { z } from 'zod';

let constructions = 0,
  validations = 0,
  loads = 0,
  disposals = 0;
const loader = new GraphqlLoader(
  () => ++loads,
  () => {
    disposals++;
  },
);
class Resolver {
  #id = ++constructions;
  async value(args, context) {
    return `${this.#id}:${args.count}:${await context.operation.loader(loader)}`;
  }
}
Injectable({ scope: Scope.REQUEST })(Resolver);
const args = z.object({
  count: z.string().transform(async (value) => {
    validations++;
    return Number(value);
  }),
});
const schema = createSchema({
  typeDefs: 'type Query { value(count: String!): String! }',
  resolvers: { Query: { value: bindResolver(Resolver, 'value', { args }) } },
});
assert.equal(compareGraphqlSchema(printGraphqlSchema(schema), schema).compatible, true);
class App {}
Module({
  providers: [Resolver],
  imports: [GraphqlModule.forRoot({ schema, driver: yogaDriver() })],
})(App);
const app = await VelaFactory.create(App, { diagnostics: 'silent' });
try {
  for (let request = 1; request <= 2; request++) {
    const response = await app.getHonoApp().request('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ a:value(count:"10") b:value(count:"20") }' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { a: `${request}:10:${request}`, b: `${request}:20:${request}` },
    });
  }
  assert.deepEqual(
    { constructions, validations, loads, disposals },
    { constructions: 2, validations: 4, loads: 2, disposals: 2 },
  );
} finally {
  await app.dispose();
}

// The packed SDL path discovers decorated providers and preserves field ownership.
const {
  Resolver: ResolverDecorator,
  Query,
  ResolveField,
  Args,
  Parent,
} = await import('@velajs/graphql');
class ItemResolver {
  item(id) {
    return { id };
  }
  label(item) {
    return `Item ${item.id}`;
  }
}
ResolverDecorator('Item')(ItemResolver);
Query('item')(
  ItemResolver.prototype,
  'item',
  Object.getOwnPropertyDescriptor(ItemResolver.prototype, 'item'),
);
Args('id')(ItemResolver.prototype, 'item', 0);
ResolveField('label')(
  ItemResolver.prototype,
  'label',
  Object.getOwnPropertyDescriptor(ItemResolver.prototype, 'label'),
);
Parent()(ItemResolver.prototype, 'label', 0);
class DecoratedApp {}
Module({
  providers: [ItemResolver],
  imports: [
    GraphqlModule.forRoot({
      typeDefs: 'type Item { id: ID!, label: String! } type Query { item(id: ID!): Item! }',
      driver: yogaDriver(),
    }),
  ],
})(DecoratedApp);
const decorated = await VelaFactory.create(DecoratedApp);
try {
  const response = await decorated.getHonoApp().request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ item(id: "7") { id label } }' }),
  });
  assert.deepEqual(await response.json(), { data: { item: { id: '7', label: 'Item 7' } } });
} finally {
  await decorated.dispose();
}
