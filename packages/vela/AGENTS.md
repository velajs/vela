# Vela core

Follow the root contributor and release guides. The core provides NestJS-style
modules and request pipelines using Hono and Web APIs.

## Runtime boundaries

Keep portable exports free of Node-specific imports, `Buffer`, `process`, and
runtime-specific server APIs. Use Web Crypto, `Uint8Array`, `TextEncoder`, `URL`,
and `fetch`. Node scheduling and WebSocket adapters belong in their explicit
Node entrypoints. Ambient context is opt-in through Hono context storage.

Preserve per-application module boundaries and per-request container ownership.
Use the public module, discovery, and entrypoint APIs when adding integrations.
See MODULE_AUTHORING.md, TYPE_CONTRACTS.md, and SECURITY.md for their contracts.

## Validation

Use `pnpm --filter @velajs/vela test` for core tests and the Workers suites for
runtime-specific behavior. Review public API snapshot changes, keep authoring
examples and the bundled Vela skill accurate, and run the root verification gate.
