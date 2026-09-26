import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  bindResolver,
  Args,
  GraphqlModule,
  GraphqlLoader,
  type GraphqlOperation,
  type GraphqlResolverContext,
} from '../index';
import { buildSchema, parse } from 'graphql';
import { yogaDriver } from '../yoga';

class Resolver {
  find(args: { id: number }, _context: GraphqlResolverContext) {
    return { id: args.id };
  }
  wrong(args: { id: string }) {
    return args.id;
  }
}
const args = z.object({ id: z.string().transform(Number) });
const field = bindResolver(Resolver, 'find', { args });
expectTypeOf<Awaited<ReturnType<typeof field>>>().toEqualTypeOf<{ id: number }>();
const serialized = bindResolver(Resolver, 'find', {
  args,
  output: z.object({ id: z.number() }).transform(({ id }) => String(id)),
});
expectTypeOf<Awaited<ReturnType<typeof serialized>>>().toEqualTypeOf<string>();
// @ts-expect-error wire input strings do not match transformed resolver numbers
bindResolver(Resolver, 'wrong', { args });
// @ts-expect-error unknown methods are rejected
bindResolver(Resolver, 'absent', { args });
const loader = new GraphqlLoader(async () => new Map<string, number>());
declare const operation: GraphqlOperation;
expectTypeOf(operation.loader(loader)).toEqualTypeOf<Promise<Map<string, number>>>();

const driver = yogaDriver();
const schema = buildSchema('type Query { value: String }');
GraphqlModule.forRoot({ schema, driver });
GraphqlModule.forRoot({ typeDefs: 'type Query { value: String }', include: [], driver });
GraphqlModule.forRoot({ typeDefs: parse('type Query { value: String }'), driver });
GraphqlModule.forRootAsync({
  useFactory: () => ({ typeDefs: 'type Query { value: String }', include: [], driver }),
});
// @ts-expect-error Select exactly one schema source.
GraphqlModule.forRoot({ schema, typeDefs: 'type Query { value: String }', driver });
// @ts-expect-error A schema source is required.
GraphqlModule.forRoot({ driver });
// @ts-expect-error Executable schemas do not discover decorated resolvers.
GraphqlModule.forRoot({ schema, include: [], driver });
GraphqlModule.forRootAsync({
  // @ts-expect-error include is resolved with the schema options, not structural module wiring.
  include: [],
  useFactory: () => ({ typeDefs: 'type Query { value: String }', driver }),
});
// @ts-expect-error Argument names are strings, not a code-first type callback.
Args(() => String);
