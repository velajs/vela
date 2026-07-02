# Vela Framework

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

### AsyncLocalStorage (ambient context)
- Core MUST NOT statically `import 'node:async_hooks'` (breaks the `node:*` rule and esbuild/Wrangler bundling).
- Opt-in ambient request access (`getCurrentContainer()` / `getCurrentRequestContext()`) is implemented via **Hono's `hono/context-storage`** — the `node:async_hooks` dependency lives inside Hono, not vela. It is OFF by default (`VelaFactory.create(module, { ambientContainer: true })`); the explicit per-request child container remains the default DI path.
- Only the workerd-safe ALS subset is relied on (`run()`/`getStore()`); no `enterWith`, no cross-thenable propagation. Cloudflare Workers require `nodejs_als`/`nodejs_compat`.

## Architecture

- **MetadataRegistry**: Central metadata store, anchored on `globalThis` via `Symbol.for('vela:registry:v1')` so Vite HMR re-eval reuses the same state (no split-brain).
- **Container**: DI container with scopes (singleton, request, transient) + LIFO `dispose()` (Symbol.asyncDispose / Symbol.dispose / `.dispose()`); request children dispose only their own request-scoped instances.
- **ConfigurableModuleBuilder** (`module/`): NestJS-parity generator for `forRoot`/`forRootAsync` (+ `key`, `global`, `useClass`/`useExisting`, options token). Prefer it for new configurable modules; `defineConfigurableModule` is the lower-level engine (used by `@velajs/cloudflare`'s binding modules).
- **ComponentManager**: Unified component management (guards, pipes, interceptors, filters) with 3-level hierarchy (global → controller → handler)
- **RouteManager**: Builds Hono routes from registered controllers with full request pipeline
- **ModuleLoader**: Depth-first recursive module tree processing

## Testing

Run tests with `pnpm test`. Use Hono's `app.request()` for integration tests.
