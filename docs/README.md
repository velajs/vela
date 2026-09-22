# Vela documentation

Start with [Create a Workers API](getting-started.md), then the
[framework guide](../packages/vela/README.md) and
[Cloudflare integration](../packages/cloudflare/README.md). The
[API starter](../apps/api-starter/README.md) combines authentication, D1, a typed
HTTP client, live queries, and Studio in a runnable Workers application.

## Framework guides

- [Upgrading framework integrations](upgrading-framework.md): behavior changes,
  compatibility boundaries, and migration steps after the 1.24.0 baseline.
- [Debugging](debugging.md): Worker and test breakpoints, structured Studio logs,
  handler timing, and module ownership snapshots.

- [Module authoring](modules.md): configurable modules, dependency injection,
  discovery, entrypoints, and lazy initialization.
- [Runtime values and types](types.md): schema descriptors, request context,
  validation, and typed contracts.
- [Response caching](caching.md): asynchronous stores, trusted partitions, tags,
  expiry, and explicit post-commit invalidation.
- [Response serialization](serialization.md): async output schemas and explicit
  projections for domain objects, including private state.
- [Dependency injection](dependency-injection.md): registration ownership,
  async construction, provider scopes, and diagnostic snapshots.
- [Queues](queues.md): validated job contracts, owned dispatch, and native
  Cloudflare producers and consumers.
- [Scheduling](scheduling.md): cron dialects and invocation-owned execution.
- [Execution scopes](execution-scopes.md): invocation ownership, deferred work,
  streaming completion, and transport integration.
- [Security configuration](security.md): request limits, browser origins,
  identity, response caching, signed URLs, and WebSocket boundaries.
- [Logging](logging.md): application-owned records, redaction, sinks, and invocation correlation.
- [WebSockets](websockets.md): gateways, transports, rooms, and authentication.
- [Live queries](live-queries.md): subscriptions, invalidation, reconnects,
  delivery guarantees, and runtime limits.

## Integrations

- [Cloudflare security](cloudflare-security.md): platform identity, signed R2
  URLs, and Durable Object WebSockets.
- [HTTP clients](client/HTTP.md): generated contracts and Hono RPC.
- [Method RPC](../packages/rpc/README.md): shared procedure contracts and typed HTTP/Fetcher calls.
- [GraphQL](../packages/graphql/README.md): explicit schemas, scoped resolvers, and operation loaders.
- [Live clients](client/README.md): subscriptions, optimistic updates, offline
  mutations, and React integration.
- [CRUD](crud/README.md): resources, adapters, authorization, and data safety.
- [Atomic writes](atomic-writes.md): typed batches and optional atomic metadata-only audits.
- [Multiple databases](multi-database.md): typed registration, resource routing,
  owned transactions, and separate migrations.
- [Domain event sourcing](event-sourcing.md): replayable business history, projections,
  checkpoints, and boundaries with CRUD/live queries.
- [Studio](studio/README.md): the admin module, local host, and inspection UI.

- [AI and retrieval](../packages/ai/README.md): provider-neutral model defaults,
  tenant-scoped RAG, adapter requirements, and a runnable local example.

- [Portable workflows](../packages/workflow/README.md): reusable validated steps, execution
  adapter boundaries, and the replay harness.

- [Durable agents](../packages/agent/README.md): model-directed tool workflows,
  scoped run claims, human approvals, and the runnable approval example.

## Contributing

- [Contributor guide](../CONTRIBUTING.md): setup, changes, and validation.
- [Development tooling](tooling.md): compilers, linting, tests, and API docs.
- [Release guide](../RELEASING.md): versions, package checks, and OIDC publication.

- [Tenant, Cedar, encryption and scoped CRUD](edge-capabilities.md)
