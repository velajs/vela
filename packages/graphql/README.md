# @velajs/graphql

Optional GraphQL queries and mutations for Vela, using an explicit executable schema, real DI providers, and the existing HTTP request lifetime. The runtime uses Web APIs and works in native Cloudflare Workers without `nodejs_compat`.

```sh
pnpm add @velajs/graphql @velajs/vela graphql graphql-yoga zod
```

Importing the root or `/schema` does not load Yoga. Import `yogaDriver` from `/yoga` to opt into its optional peer dependency. A different server can implement `GraphqlDriver`.

## Define the schema and provider

```ts
import { Injectable, Module, Scope } from '@velajs/vela';
import { bindResolver, GraphqlModule, type GraphqlContext } from '@velajs/graphql';
import { yogaDriver } from '@velajs/graphql/yoga';
import { createSchema } from 'graphql-yoga';
import { z } from 'zod';

class GreetingResolver {
  readonly #prefix = 'Hello';
  greet(args: { name: string }) { return `${this.#prefix}, ${args.name}`; }
}
Injectable({ scope: Scope.REQUEST })(GreetingResolver);

export class AppModule {}
Module({
  providers: [GreetingResolver],
  imports: [GraphqlModule.forRoot({
    path: '/graphql',
    driver: yogaDriver(),
    schema: () => createSchema<GraphqlContext>({
      typeDefs: 'type Query { greet(name: String!): String! }',
      resolvers: { Query: {
        greet: bindResolver(GreetingResolver, 'greet', {
          args: z.object({ name: z.string().trim().min(1).max(80) }),
        }),
      } },
    }),
  })],
})(AppModule);
```

POST `{"query":"{ greet(name: \"Vela\") }"}` as `application/json`. The [runnable Worker](../../apps/graphql-worker) also injects an environment binding and shares a cache across sibling fields.

`bindResolver` infers the method argument from the validator's **output**, including asynchronous transforms. Input validation runs once after field pipes; the optional `output` validator validates/transforms the returned value. Invalid output is an internal error. Supported validators follow Vela's `ValidationSchema` contract, including Zod, Standard Schema, and parse-style adapters. SDL types and client operation types remain explicit; the adapter does not infer a schema or expose CRUD resources automatically.

## Discovery and execution

Schema factories receive `{ discovery }` and initialize lazily once per application. Concurrent requests share the pending initialization; a rejected attempt can be retried. A supplied schema is cloned by the Yoga driver before wrapping resolvers.

Resolver bindings select the provider's declaring module, including private providers. If the same class has multiple registrations, pass `moduleId` from `discovery.getRegistrations({ metadataOnly: true })` to each binding. Select the intended registration explicitly; ambiguous bindings fail closed. Add required module imports in the application/module graph rather than relying on sibling registration order.

HTTP middleware and global components run once around the endpoint. `GraphqlModule.forRoot` accepts `guards`, `pipes`, `interceptors`, and `filters` for **each bound field**, followed by the provider's existing `UseGuards`, `UsePipes`, and `UseInterceptors` metadata. Filters run from method to class, then the configured field filters. The shared pipeline runs guards, input pipes/validation, then interceptors around invocation. Pipes use `transformAsync` when available. Filters return field data or throw; HTTP `Response` returns are rejected.

Each bound field has a frozen `GraphqlExecutionContext` with `getType() === 'graphql'`, its actual provider/method/module, the original HTTP request/context, and the request child container. `getGraphql()` adds resolver `root`, `info`, operation and cancellation signal. Providers are constructed through DI; constructors and private fields work. Guards run before request-scoped resolver construction. Unbound schema functions receive the operation context but do not acquire the provider pipeline automatically.

Authenticate and admit the tenant in the HTTP pipeline **before** starting GraphQL execution. The endpoint is marked `SkipGuardPhases(['authorize'])`: global authentication and tenant guards run on it, while global authorization guards (such as a deny-by-default `CedarGuard`) leave it to the field guards. Bound field guards reuse the trusted request identity through Vela's explicit context bridge. Use permission guards per field. GraphQL arguments do not establish authentication or tenant authority. Replacing/revoking the trusted identity during execution prevents further cache access and result publication.

## Operation resources

```ts
import { GraphqlLoader, type GraphqlResolverContext } from '@velajs/graphql';

const cache = new GraphqlLoader(
  () => new Map<string, string>(),
  (value) => { value.clear(); },
);

async function load(context: GraphqlResolverContext) {
  return context.operation.loader(cache);
}
```

A descriptor can return a DataLoader, database-specific loader collection, or any other typed resource. Its factory runs once per operation; sibling fields share the promise. Different requests, tenants and applications never share these values. Use a distinct descriptor/token for each database and resolve the appropriate repository from `operation.container`; never store a mutable global “current database.” Mutations must explicitly clear/prime affected keys or replace cached values.

The Yoga driver tracks every object-field resolver, including unbound resolvers. After execution it waits for still-running siblings, then disposes operation resources in reverse creation order. This also covers non-null failures and loader factories started without awaiting them. The managed HTTP lifetime disposes request providers. Finished operations cannot reopen loaders. Cancellation is cooperative: pass `context.signal` to asynchronous I/O; a resolver that ignores cancellation can delay cleanup. Call `app.dispose()` during application shutdown to dispose the server; `app.close()` alone only runs Vela lifecycle hooks.

Custom drivers must track their resolver work through `operation.track`, stop/drain it before completion, return a completed non-streaming response, and apply their own safe error mapping and request limits. Subscriptions and incremental responses need a separate lifetime contract.

## Transport and errors

The Yoga driver accepts one JSON POST containing one query or mutation. It rejects batches, subscriptions, multipart uploads, GET, `@defer`, and `@stream`. GraphiQL, landing pages, introspection and Yoga CORS are disabled by default; configure application CORS at the HTTP boundary. `yogaDriver({ introspection: true })` explicitly enables introspection.

Defaults are 65,536 request bytes, 5,000 document tokens, depth 16, and 200 expanded fields. Override these through `maxRequestBytes`, `maxDocumentTokens`, `maxDepth`, and `maxFields`. These bounds do not limit list cardinality, resolver cost, or response size: bound pagination and expensive work in your domain layer.

Unexpected resolver/output errors use `INTERNAL_SERVER_ERROR` and a fixed message. Validation and supported HTTP statuses map to bounded public codes/messages; the status comes from Vela's shared `renderHttpError`, so an `HttpException`, a branded `VelaError` (such as `forbidden` or `not_found`) and an exception-owned `toResponse()` map alike. Throw `GraphqlClientError` for an intentional public message. Responses include at most ten errors with messages capped at 512 characters; arbitrary extensions and stacks are removed. Resolver errors are sent to Vela's error reporter. Authenticate HTTP requests before execution if you require HTTP 401/403; individual denied fields otherwise follow GraphQL partial-data semantics.

## SDL and compatibility checks

`@velajs/graphql/schema` exports portable `printGraphqlSchema(schema)` and `compareGraphqlSchema(previousSDL, schema)`. Printing sorts types/fields and preserves applied directives. Comparison returns `compatible`, `breaking`, and `dangerous` from GraphQL's schema-change analysis. Keep the baseline in source control and compare **before** replacing it. Your Node/CI script owns filesystem reads/writes and client code generation. Compatibility checks do not assess resolver behavior, authorization, directive semantics or operational cost.

The Yoga adapter uses its [Worker integration](https://the-guild.dev/graphql/yoga-server/docs/integrations/integration-with-cloudflare-workers) and [plugin hooks](https://the-guild.dev/graphql/yoga-server/docs/features/envelop-plugins), with Vela-specific ownership and error policy.
