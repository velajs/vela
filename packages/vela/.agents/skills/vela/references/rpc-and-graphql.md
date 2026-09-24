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
identity. Guards precede handler construction. Consume or cancel the
response body so managed work and resource disposal can complete.

## GraphQL

`@velajs/graphql` binds explicit executable-schema fields to real DI providers
through `bindResolver`; it does not expose CRUD automatically. Use
`GraphqlModule.forRoot` with a schema and driver. `@velajs/graphql/yoga` opts into
the Yoga peer; root and `/schema` imports do not load it.

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
