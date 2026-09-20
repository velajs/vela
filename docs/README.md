# Vela documentation

Start with the [framework quick start](../packages/vela/README.md) and
[Cloudflare integration](../packages/cloudflare/README.md). The
[API starter](../apps/api-starter/README.md) combines authentication, D1, a typed
HTTP client, live queries, and Studio in a runnable Workers application.

## Framework guides

- [Module authoring](modules.md): configurable modules, dependency injection,
  discovery, entrypoints, and lazy initialization.
- [Runtime values and types](types.md): schema descriptors, request context,
  validation, and typed contracts.
- [Security configuration](security.md): request limits, browser origins,
  identity, response caching, signed URLs, and WebSocket boundaries.
- [WebSockets](websockets.md): gateways, transports, rooms, and authentication.
- [Live queries](live-queries.md): subscriptions, invalidation, reconnects,
  delivery guarantees, and runtime limits.

## Integrations

- [Cloudflare security](cloudflare-security.md): platform identity, signed R2
  URLs, and Durable Object WebSockets.
- [HTTP clients](client/HTTP.md): generated contracts and Hono RPC.
- [Live clients](client/README.md): subscriptions, optimistic updates, offline
  mutations, and React integration.
- [CRUD](crud/README.md): resources, adapters, authorization, and data safety.
- [Studio](studio/README.md): the admin module, local host, and inspection UI.

## Contributing

- [Contributor guide](../CONTRIBUTING.md): setup, changes, and validation.
- [Development tooling](tooling.md): compilers, linting, tests, and API docs.
- [Release guide](../RELEASING.md): versions, package checks, and OIDC publication.
