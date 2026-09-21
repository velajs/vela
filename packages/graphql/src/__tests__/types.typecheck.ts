import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  bindResolver,
  GraphqlLoader,
  type GraphqlOperation,
  type GraphqlResolverContext,
} from '../index';

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
