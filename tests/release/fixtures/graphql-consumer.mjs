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
