# Optional RPC and GraphQL

Keep shared wire contracts free of server providers and environment bindings.
Use the optional packages' existing HTTP integration and invocation helpers;
do not create a second DI container or copy trusted identity from payloads.

## Method RPC

`@velajs/rpc` provides portable `defineProcedure` and `createRpcClient` APIs.
Server applications import `Rpc` and `rpcAdapter` from `@velajs/rpc/server`.
Annotate registered provider methods and pass an explicit `authorize` policy to
the adapter. Procedure names are namespaced and unique per application.

Distinguish wire input, parsed handler input, handler result, and projected wire
output. The server awaits each schema once; the client validates the envelope
and correlation, without repeating transforming server schemas. Use a separate
wire-result decoder for an independently deployed or untrusted peer. Default
calls make one attempt; retries require an idempotent procedure and explicit
retry options. Deadlines include setup, I/O, and response consumption.

The adapter reuses the HTTP child, global/scoped pipeline, module owner and
trusted identity. The `authorize` policy runs in the global `authorize` phase,
after global authentication and tenant guards, so it can read the trusted
identity. Global guards run on every procedure, including the tenant,
Cedar, authorization and feature-flag guards the application installs, so
procedures need a tenant, a Cedar declaration (`@CedarPublic()` or
`@RequireResource()` on the provider or method) and so on, as routes do.
Guards precede handler construction. Consume or cancel the
response body so managed work and resource disposal can complete.

## GraphQL

`GraphqlModule.forRoot` accepts either an executable `schema` or schema-first
`typeDefs: string | DocumentNode`, together with a driver. SDL mode discovers
registered `@Resolver('Type')` providers with `@Query`, `@Mutation` and
`@ResolveField` methods. Parameters use `@Args('name')`, `@Parent`, `@Context`
and `@Info`. Omitted `include` scans the application; `include: [FeatureModule]`
selects providers declared by those module classes; `[]` selects none. It never
imports a module and duplicate field bindings fail. SDL performs coercion;
optional method-level `args` and `output` schemas add pipeline validation.
Executable schemas retain `bindResolver`. The `/yoga` entrypoint alone opts into
the optional Yoga peer. Subscriptions and code-first generation are unsupported.

Select `moduleId` explicitly for multiply registered resolver classes. Field
guards and pipes use the selected provider owner. Authenticate and admit the
tenant in the outer HTTP pipeline; bound fields use the explicit trusted-context
bridge. Separate operation loaders by database, and invalidate mutation caches
explicitly. Loader resources are operation-owned; request providers remain
owned by HTTP.

The initial Yoga adapter supports one JSON POST query or mutation. Batching,
subscriptions, uploads and incremental responses need separate lifetime
contracts. Schema/client operation types stay explicit. Use `/schema` for
portable SDL printing and compatibility comparison.
