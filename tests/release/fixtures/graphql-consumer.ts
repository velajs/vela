import { bindResolver, GraphqlLoader, type GraphqlResolverContext } from '@velajs/graphql';
import { compareGraphqlSchema, printGraphqlSchema } from '@velajs/graphql/schema';
import { yogaDriver } from '@velajs/graphql/yoga';
import { z } from 'zod';

class Resolver {
  value(args: { count: number }, _context: GraphqlResolverContext) {
    return args.count;
  }
  wrong(args: { count: string }) {
    return args.count;
  }
}
const args = z.object({ count: z.string().transform(Number) });
const resolver = bindResolver(Resolver, 'value', { args });
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exactOutput: Equal<Awaited<ReturnType<typeof resolver>>, number> = true;
// @ts-expect-error transformed arguments are numbers, not their string wire input
bindResolver(Resolver, 'wrong', { args });
// @ts-expect-error method names must exist on the provider
bindResolver(Resolver, 'missing', { args });
const loader = new GraphqlLoader(() => new Map<string, number>());
void [loader, exactOutput, yogaDriver, compareGraphqlSchema, printGraphqlSchema];

// Every decorator is available from the package root in the packed declarations.
import {
  Resolver as ResolverDecorator,
  Query,
  Mutation,
  ResolveField,
  Args,
  Parent,
  Context,
  Info,
} from '@velajs/graphql';
void [ResolverDecorator, Query, Mutation, ResolveField, Args, Parent, Context, Info];
