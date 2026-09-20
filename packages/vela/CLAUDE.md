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

- **MetadataRegistry**: Central metadata store, anchored on `globalThis` via `Symbol.for('vela:registry:v1')` so Vite HMR re-eval reuses the same state (no split-brain). Maintains a reverse index (metaKey → classes) backing `DiscoveryService`.
- **Container**: DI container with scopes (singleton, request, transient) + LIFO `dispose()` (Symbol.asyncDispose / Symbol.dispose / `.dispose()`); request children dispose only their own request-scoped instances. `replaceProvider` force-replaces across module buckets (testing). Factory `inject` deps resolve from the declaring module's scope first (legacy no-requester fallback kept).
- **defineModule** (`module/define-module.ts`): THE module-authoring engine — generates `forRoot`/`forRootAsync`, deterministic `stableHash` keys, options-derived contributions, `global:` component slot. `ConfigurableModuleBuilder` (NestJS parity) is a thin adapter over it; `defineConfigurableModule` remains the low-level engine for runtime-generated module classes. Companions: `lazyProvider`, `provideGlobal`, `sideEffectModule`, `moduleToken`. Author contract: `MODULE_AUTHORING.md`.
- **DiscoveryService** (`discovery/`): decorator-driven provider/method discovery (+ `createDiscoverableDecorator`); the only sanctioned way to find annotated providers — never hand-roll `container.getTokens()` scans.
- **EntrypointRegistry** (`entrypoint/`): open non-HTTP entry surface. Kinds declared via `registerEntrypointKind` (globalThis-anchored) or computed via `ContributesEntrypoints`; per-app `app.entrypoints` built at the end of `callOnApplicationBootstrap()` (slim DO paths included).
- **ComponentManager**: stateless controller/handler-tier component registration + resolution (`getScopedComponents`, explicit-container `resolve*`). App-wide components have ONE source: the per-app RouteManager (`APP_*` tokens + `useGlobalX()`).
- **PipelineRunner** (`pipeline/pipeline-runner.ts`): shared guard → pipe → interceptor core for HTTP, WS, and custom dispatchers (HTTP keeps args-before-guards; WS guards-first).
- **RouteManager**: Builds Hono routes from registered controllers with full request pipeline; consults `RouteContributor`s (metadata-claimed route generators, e.g. `@velajs/crud`) after explicit routes.
- **RuntimeAdapter** (`factory/adapter.ts`): platform bindings via `VelaFactory.create(m, { adapters })` — `requestMiddleware` / `onBootstrap` / `onRoutesBuilt`.
- **ModuleLoader**: Depth-first recursive module tree processing

## Testing

Run tests with `pnpm test`. Use Hono's `app.request()` for integration tests.
