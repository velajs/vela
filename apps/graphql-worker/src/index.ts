import { createCloudflareWorker } from '@velajs/cloudflare';
import {
  GraphqlModule,
  GraphqlLoader,
  bindResolver,
  type GraphqlContext,
  type GraphqlResolverContext,
} from '@velajs/graphql';
import { yogaDriver } from '@velajs/graphql/yoga';
import { InjectEnv, Injectable, Module, Scope, type VelaEnv } from '@velajs/vela';
import { createSchema } from 'graphql-yoga';
import { z } from 'zod';

// Any DataLoader implementation can be returned here. This small cache illustrates ownership.
const greetings = new GraphqlLoader(
  () => new Map<string, string>(),
  (cache) => {
    cache.clear();
  },
);
@Injectable({ scope: Scope.REQUEST })
class GreetingResolver {
  readonly #label: string;
  // APP_LABEL is typed by worker-configuration.d.ts, which `pnpm types` generates.
  constructor(@InjectEnv() env: VelaEnv) {
    this.#label = env.APP_LABEL;
  }
  async greet(args: { name: string }, context: GraphqlResolverContext): Promise<string> {
    const cache = await context.operation.loader(greetings);
    const previous = cache.get(args.name);
    if (previous) return previous;
    const greeting = `${this.#label}: hello, ${args.name}`;
    cache.set(args.name, greeting);
    return greeting;
  }
}
@Module({
  providers: [GreetingResolver],
  imports: [
    GraphqlModule.forRoot({
      driver: yogaDriver(),
      schema: () =>
        createSchema<GraphqlContext>({
          typeDefs: 'type Query { greet(name: String!): String! }',
          resolvers: {
            Query: {
              greet: bindResolver(GreetingResolver, 'greet', {
                args: z.object({ name: z.string().trim().min(1).max(80) }),
              }),
            },
          },
        }),
    }),
  ],
})
export class AppModule {}

export default createCloudflareWorker(AppModule);
