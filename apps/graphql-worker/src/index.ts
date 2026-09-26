import { createCloudflareWorker } from '@velajs/cloudflare';
import {
  GraphqlModule,
  GraphqlLoader,
  Resolver,
  Query,
  Args,
  Context,
  type GraphqlResolverContext,
} from '@velajs/graphql';
import { yogaDriver } from '@velajs/graphql/yoga';
import { InjectEnv, Injectable, Module, Scope, type VelaEnv } from '@velajs/vela';
import { z } from 'zod';

// Any DataLoader implementation can be returned here. This small cache illustrates ownership.
const greetings = new GraphqlLoader(
  () => new Map<string, string>(),
  (cache) => {
    cache.clear();
  },
);
@Injectable({ scope: Scope.REQUEST })
@Resolver()
class GreetingResolver {
  readonly #label: string;
  // APP_LABEL is typed by worker-configuration.d.ts, which `pnpm types` generates.
  constructor(@InjectEnv() env: VelaEnv) {
    this.#label = env.APP_LABEL;
  }
  @Query('greet', { args: z.object({ name: z.string().trim().min(1).max(80) }) })
  async greet(
    @Args('name') name: string,
    @Context() context: GraphqlResolverContext,
  ): Promise<string> {
    const cache = await context.operation.loader(greetings);
    const previous = cache.get(name);
    if (previous) return previous;
    const greeting = `${this.#label}: hello, ${name}`;
    cache.set(name, greeting);
    return greeting;
  }
}
@Module({
  providers: [GreetingResolver],
  imports: [
    GraphqlModule.forRoot({
      driver: yogaDriver(),
      typeDefs: 'type Query { greet(name: String!): String! }',
    }),
  ],
})
export class AppModule {}

export default createCloudflareWorker(AppModule);
