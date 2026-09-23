# Incremental Adoption

Migrating a NestJS codebase to Vela, or embedding a Vela app inside an existing Hono app. Everything here is grounded in what Vela actually ships — where a NestJS convenience has no Vela equivalent, this doc says so rather than inventing one.

## NestJS → Vela: what maps 1:1

Vela mirrors NestJS's authoring surface, so most decorators and interfaces port unchanged (all from `@velajs/vela`):

- **Decorators:** `@Module`, `@Global`, `@Controller`, `@Get/@Post/@Put/@Patch/@Delete/@Options/@Head/@All`, `@Param/@Query/@Body/@Headers/@Req/@Res`, `@Injectable`, `@Inject`, `@Optional`, `@UseGuards/@UsePipes/@UseInterceptors/@UseFilters`, `@Catch`, `@SetMetadata`, `@Version`.
- **DI:** constructor injection, `forwardRef`, `ModuleRef`, `Reflector`, and the three scopes (`Scope.DEFAULT/REQUEST/TRANSIENT`).
- **Lifecycle hooks (same names):** `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`, `OnApplicationShutdown`, `BeforeApplicationShutdown`.
- `ConfigurableModuleBuilder` is provided for parity (it is a thin adapter over `defineModule`).

## What differs

| NestJS | Vela | Notes |
|---|---|---|
| class-validator + class-transformer DTOs | **Schemas** via `defineEndpoint`, or a schema passed to the parameter decorator (`@Body(dto)`, validated by `ValidationPipe`) | core never imports class-validator — see `references/validation.md` |
| `ConfigurableModuleBuilder` for dynamic modules | **`defineModule`** (the engine; `ConfigurableModuleBuilder` adapts it) | see `references/modules-and-di.md` + `docs/modules.md` |
| `app.setGlobalPrefix('/api')` | `globalPrefix` create-option; read back via `app.getGlobalPrefix()` | there is **no** `setGlobalPrefix` method on the app |
| `app.enableVersioning({...})` | decorator-driven `@Controller({ version })` / `@Version(2)` | no `enableVersioning`/`VersioningType` |
| `app.enableCors()` | `middleware: [cors()]` create-option, or `CorsModule.forRoot({})` | no `enableCors` method |
| `logger` bootstrap option / `NestFactory.create(m, { logger })` | inject the `Logger`/`LoggerService` provider | no create-time `logger` option |
| `app.listen(port)` | export the `fetch` handler (`export default app`) or `serve({ fetch: app.fetch })` on Node | Vela is a fetch handler, not a server |
| `nest build` / `tsc` with `emitDecoratorMetadata` | **Vite 8** + `@cloudflare/vite-plugin` on Workers; Oxc emits legacy decorators + `design:paramtypes` | pass `oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } }` explicitly in the Vite **and** Vitest configs — see "Build and test" below |
| Jest + `@nestjs/testing` | Vitest + `@cloudflare/vitest-plugin` (workerd), `@velajs/testing` | see `references/testing.md` |

`VelaFactory.create(rootModule, options?)` is **always async** and returns `Promise<VelaApplication>`. `VelaCreateOptions` in full: `globalPrefix`, `middleware`, `getClientIp`, `adapters`, `ambientContainer`, `diagnostics` — nothing else. Authoring configurable modules uses `defineModule`, not hand-wired `forRoot`; see the module reference.

## Build and test

NestJS compiles with `tsc`, which reads `emitDecoratorMetadata` from tsconfig. A Vela Worker builds with Vite 8 instead (`vela new` generates this setup; `docs/tooling.md` has the full list of pitfalls):

- `vite.config.ts`: `defineConfig({ oxc, plugins: [cloudflare()] })`; `vitest.config.ts`: `defineConfig({ oxc, plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })] })`, sharing one exported `oxc = { decorator: { legacy: true, emitDecoratorMetadata: true } }`. Always pass it explicitly — tsconfig auto-detection skips files outside `include`, which then fail as TC39 decorators. Never add `cloudflare()` to the Vitest config.
- `wrangler.jsonc` `main` is `src/worker.ts` with no `build` block. Deploy with `vite build && wrangler deploy` (no `--config`: an explicit config makes Wrangler bundle `src/` with esbuild, which drops decorator metadata).
- Enable `verbatimModuleSyntax` + `isolatedModules`: Oxc compiles file by file, so a plain `import { SomeInterface }` in a decorated signature breaks at link time. Import injected classes as values, never `import type`.
- In Workers tests, read the response body before `await waitOnExecutionContext(ctx)`.
- If you turn on `build.minify`, set `build.rolldownOptions.output.keepNames: true`.
- `vela.config.ts` can import `./src/...` directly: `@velajs/cli` loads it through a Vite module runner that stays open for the whole command, with the same Oxc options, when `vite` is installed.
- A Nest `UnknownDependenciesException` corresponds to Vela's `UnresolvedDependencyError`: `Cannot resolve UsersController(?, AuditService) in UsersModule. Argument #0 UsersService is declared in DataModule but not exported (add it to DataModule.exports)`.

## Embedding a Vela app inside an existing Hono app

Vela's app is a real Hono instance under the hood, exposed two ways:

- `app.getHonoApp(): Hono` — the built Hono instance (all routes mounted).
- `app.fetch` — the WHATWG fetch handler (`Hono['fetch']`).

The **source-demonstrated** embedding path is native Hono sub-app mounting with `route()`:

```ts
import { Hono } from 'hono';
import { VelaFactory } from '@velajs/vela';

const vela = await VelaFactory.create(AppModule, { globalPrefix: '/api' });

const parent = new Hono();
parent.get('/health', (c) => c.text('ok'));      // your existing Hono routes
parent.use('*', myExistingMiddleware);
parent.route('/', vela.getHonoApp());             // mount the Vela app as a sub-app

export default parent;
```

Because Vela bakes `globalPrefix` into each route path at build time, mounting under a parent base path **stacks** the parent segment on top of Vela's already-prefixed paths — usually mount at `/` and let `globalPrefix` own the prefix. `app.fetch` is the top-level entry handler (`export default app` on Workers; `serve({ fetch: app.fetch })` on Node via `@hono/node-server`); mounting a Vela app *under* another app via Hono's `.mount()` is not exercised in the source, so prefer `parent.route(base, app.getHonoApp())`.

## Bringing existing middleware and platform wiring in

- **Existing Hono middleware** drops straight into the `middleware` create-option (each is a Hono `MiddlewareHandler`): `VelaFactory.create(AppModule, { middleware: [cors({ origin: '*' }), logger()] })`. This is the sanctioned global-middleware hook — there is no `app.use()`.
- **Platform integration** goes through a `RuntimeAdapter` (`{ name, requestMiddleware?, onBootstrap?, onRoutesBuilt? }`), passed via `adapters`. `requestMiddleware` prepends to the global chain; `onRoutesBuilt` runs after the Hono app exists — the documented place to mount extra platform routes via `ctx.app.getHonoApp()`. `@velajs/cloudflare`'s adapter is built exactly this way (see `references/cloudflare.md`).
- **Generated routes**: `@velajs/crud` (>= 1.18) stamps REAL controller routes at decoration time (no contributor); other generators can still attach through `registerRouteContributor` / `RouteContributor`, consulted after explicit routes — see `references/crud.md`.

## Edge-runtime checklist

The main `@velajs/vela` export is edge-pure by contract, enforced in CI (an audit scans every source file). When migrating Node-only code, remove:

- `node:*` imports, `fs`/`path`/`os`/`child_process`
- `Buffer` → use `Uint8Array` + `TextEncoder`/`TextDecoder`
- `process` (incl. `process.env`) → read the runtime environment through `ENV` (`@InjectEnv()`, `registerAs` factories, `ConfigService`), never `process.env`; a Node entry seeds it with `VelaFactory.create(AppModule, { env: process.env })`
- `__dirname` / `__filename`, `setInterval`, `Bun.serve()`
- Node `crypto` → Web Crypto

The one sanctioned exception is `@velajs/vela/schedule-node`, an opt-in Node/Bun cron executor — don't import it on edge runtimes (see `references/schedule-and-cron.md`). Ambient request access (`getCurrentContainer()` / `getCurrentRequestContext()`) is off by default; enabling it (`ambientContainer: true`) uses Hono's `context-storage`. The root entry imports that module either way, so Cloudflare Workers need `node:async_hooks` even when the default DI path, the explicit per-request child container, is all you use: `nodejs_compat` is default-on from compatibility date 2026-08-04, and earlier dates need the `nodejs_als` (or `nodejs_compat`) flag.
