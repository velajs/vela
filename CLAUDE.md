# Edgest Framework

NestJS-compatible framework for edge runtimes, powered by Hono.

## Edge Runtime Rules

This framework MUST be compatible with all edge runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge, Bun, Node.js).

### Forbidden APIs
- No `node:*` imports (no `node:fs`, `node:path`, `node:crypto`, etc.)
- No `Buffer` — use `Uint8Array` + `TextEncoder`/`TextDecoder`
- No `process` (no `process.env`, `process.on`, `process.exit`)
- No `__dirname`, `__filename`
- No `fs`, `path`, `os`, `child_process`
- No `setInterval` (not available in all edge runtimes)
- No `Bun.serve()` or any runtime-specific server APIs

### Use Instead
- Web Crypto API instead of Node crypto
- `Uint8Array` + `TextEncoder`/`TextDecoder` instead of Buffer
- `URL` and string manipulation instead of `path`
- `fetch` for HTTP calls
- Hono's `app.fetch` for the universal entry point

## Architecture

- **MetadataRegistry**: Central static store for all framework metadata
- **Container**: DI container with scopes (singleton, transient)
- **ComponentManager**: Unified component management (guards, pipes, interceptors, filters) with 3-level hierarchy (global → controller → handler)
- **RouteManager**: Builds Hono routes from registered controllers with full request pipeline
- **ModuleLoader**: Depth-first recursive module tree processing

## Testing

Run tests with `bun test`. Use Hono's `app.request()` for integration tests.
