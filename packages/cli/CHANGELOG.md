# @velajs/cli

## 1.35.0

### Minor Changes

- 9a00506: Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.
  
  Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.
  
  Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.
  
  Update CLI output, runnable examples, packed consumers and migration documentation together. Keep root Cloudflare declarations usable without installing the optional Feature Flags peer. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.

### Patch Changes

- Updated dependencies [9a00506]
  - @velajs/vela@1.34.0

## 1.34.0

### Minor Changes

- 2c61e5b: Unify Wrangler binding discovery across resource addition, configuration sync and deployment checks. Cover current native binding shapes, detect cross-kind name collisions, respect environment inheritance exceptions, and preserve unknown configuration. Known malformed bindings now fail before resource creation or config edits.
  
  Add `vela add binding <kind> <BINDING> --options <JSON>` for native JSON/JSONC declarations without provisioning resources or adding modules. Selected-environment type generation now calls Wrangler with `--env` instead of running an unqualified types script.
  
  Expose `flagship({ binding })` and `secretsStoreSecret({ binding })` native references from `@velajs/cloudflare`, resolving the original handle separately for each environment without caching values.

## 1.33.0

### Minor Changes

- e36ecd5: Publish starter templates pinned to the current core, Cloudflare, testing, and CLI releases. Raise the Agent integration's optional AI and mail peer minimums to the releases with the current contracts.

### Patch Changes

- Updated dependencies [b7d0725]
- Updated dependencies [b7d0725]
  - @velajs/vela@1.33.0

## 1.32.0

### Minor Changes

- 5410c9d: `vela add` and the generators' source edits are safer:
  
  - `vela add queue` plans its Wrangler file edit (the producer and consumer) before `wrangler queues create`, so a Wrangler file it cannot edit, such as one whose `queues` is not an object, fails with nothing created.
  - A D1, KV or R2 `BINDING` that is a JavaScript reserved word (`delete`, `class`, `await`, `eval`, ...) or a name `bindings.module.ts` declares (a class, function, variable, destructured variable or enum) or imports (`ENV`, `Global`, `InjectionToken`, `Module`, `defineProvider`, its module class) is refused before anything is created. The `export const BINDING = new InjectionToken<T>('BINDING')` an earlier `vela add` declared is reused when `T` is the resource's type (`D1Database`, `KVNamespace` or `R2Bucket`); one of another type, or without a type argument, is refused, naming both types, before anything is created.
  - An existing `bindings.module.ts` whose module class has another name is edited and imported by that name; one that does not export its class by name fails with nothing created. A root module that imports it through a relative barrel is registered through that import.
  - A module edit no longer treats a name the file declares itself, imports from another module, or imports as another export of the module (`{ Other as B }`, a default or a namespace import) as the import it needs: the edit fails naming the binding, where it used to register the wrong class. A relative module spelled with or without its extension is the same module. The same holds for an entry the module lists already: `vela g module billing` with a root that lists `BillingModule` imported from `@acme/billing` fails with nothing created, where it used to create `src/billing/billing.module.ts` and leave it unregistered (`--skip-import` creates it and prints the registration). Only `vela add` leaves a root that lists its bindings module through a path alias or package import (`@/bindings.module`) as it is, since only the project's build resolves that specifier.
  - Source edits keep a CRLF file CRLF, and a comment trailing the last import, export or declaration stays on its line.
  
  **Behavior change:** with a `wrangler.toml`, which neither Wrangler nor the CLI edits, `vela add d1|kv|r2|queue` still creates and registers the resource, but prints the binding table to add (`[[d1_databases]]`, `[[kv_namespaces]]` or `[[r2_buckets]]`, with a placeholder for the id Wrangler printed, or a queue's producer and consumer) and the type refresh under `Manual steps required`, numbered, and exits 2 instead of 0. D1, KV and R2 used to exit 0 with the binding missing from the Wrangler file. Exit codes: 0 means everything was applied, apart from the registration `--skip-import` prints; 1 that the command failed; 2 that the printed manual steps remain.
- 5e75262: `vela cf sync` keeps the cron triggers no `@Cron` job declares: a Worker entry with its own `scheduled` handler may serve them. It reports each one as `triggers.crons: "30 5 * * *" is not declared by any @Cron job; kept (pass --prune to remove it).` The new `--prune` flag removes them, and lists their removal when comparing.
  
  **Behavior change:** `vela cf sync --write` no longer deletes cron triggers that no `@Cron` job declares, and a comparison no longer fails on them; pass `--prune` for the previous behavior.
- 5a34826: The CLI reads the Durable Object classes a Worker entry defines through `@velajs/cloudflare`. It finds the root module of an entry that uses `defineCloudflareApp(AppModule)` as well as one that uses `createCloudflareWorker(AppModule)`.
  
  **Behavior change:** `vela g durable-object counter` writes an `@Injectable()` host (`counter.host.ts`, which injects `DO_STORAGE`) and a `VelaDurableObject` class instead of a hand-written `DurableObject` subclass. The class lists the host's `increment` method in `rpc`, typed on its binding once `vela cf sync --write` binds it and `wrangler types` runs; list further host methods there to expose them. Where the class goes follows the Worker entry, so it shares the app's runtime adapters:
  
  - An entry that binds its app (`const app = defineCloudflareApp(AppModule, options)`) gets `export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}` declared after the app. A separate file importing the entry would run before the entry defined the app.
  - An entry that imports its app from its own module (`import { app } from './app.js'; export default app.worker;`) gets `counter.durable-object.ts`, which imports that app, exported from the entry.
  - Otherwise `counter.durable-object.ts` builds the class from the root module the entry names (`VelaDurableObject(AppModule, CounterHost, { rpc: ['increment'] })`), exported from the entry as before. When the entry passes options, such as runtime adapters, to `createCloudflareWorker()` or an unnamed `defineCloudflareApp()`, the generator notes that the class does not share them and how to define the app once. An entry that names no root module fails with guidance.
  - `--skip-import` prints the declaration or export to add instead.
  
  **Behavior change:** `vela cf sync` binds a gateway binding that no class serves to the one exported `VelaWebSocketDurableObject` class without a binding, or, when there is none, to the one unbound class that is not a `VelaDurableObject` host, and never to a host class. It also warns about a Durable Object class the app defines that the Worker entry does not export, naming the call that defined it with its `rpc` list, so you export that class.
  
  **Behavior change:** without a config, `vela entrypoint list` adds `cf:durable-object` rows: the Durable Object classes built by `@velajs/cloudflare` that the Worker entry exports, by export name, with what they serve and their RPC methods, and the classes the app defines without exporting them. `vela deploy check` reads those rows. It warns with `unbound-durable-object` about an exported class that no `durable_objects` binding of the selected environment names, and with `unexported-durable-object` about a class the entry does not export. It warns with `rpc-error-serialization` when an exported host class has RPC methods and the selected environment's `compatibility_date` predates 2026-04-21 without the `enhanced_error_serialization` flag (or sets `legacy_error_serialization`): workerd then delivers a failed call's `EntrypointError` without its status, code and details.
- f19f43f: The CLI knows the Workflow and service entrypoint classes a Worker entry defines through `@velajs/cloudflare`.
  
  - `vela g workflow signup` writes `signup.host.ts`, an `@Injectable()` host whose `run(event, step)` takes `SignupParams`, and declares `export class Signup extends VelaWorkflow(app, SignupHost) {}`. `vela g entrypoint billing` writes `billing.host.ts` with a `ping` method and declares `export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['ping'] }) {}`. Both run in the Worker's application, so the class is declared in the Worker entry after its app. An entry that default-exports `createCloudflareWorker(AppModule, options)` (or `defineCloudflareApp(AppModule, options).worker`) is first rewritten to `const app = defineCloudflareApp(AppModule, options);` and `export default app.worker;`; an entry that imports its app from its own module gets `signup.workflow.ts` or `billing.entrypoint.ts`, exported from the entry. An entry whose default export is anything else fails with guidance and nothing written. `--skip-import` prints the app definition and the declaration instead.
  - Without a config, `vela entrypoint list` adds `cf:workflow` rows (exported Workflow classes built with `VelaWorkflow()`, with their host) and `cf:entrypoint` rows (exported service entrypoint classes built with `VelaEntrypoint()`, with their host and RPC methods), then, under each kind, the classes the app defines without exporting them. `@OnEmail()` and `@OnTail()` handlers list as `cf:email` and `cf:tail` rows.
  - `vela deploy check` warns with `unbound-workflow` about an exported Workflow class that no `workflows` entry of the selected environment names (without `script_name`), and with `unexported-workflow` and `unexported-entrypoint` about classes the entry does not export. Exported service entrypoints with RPC methods join Durable Object hosts in the `rpc-error-serialization` warning.
  - `vela cf sync` warns about a Workflow or service entrypoint class the app defines that the entry does not export, and about a service binding to an `entrypoint` of this Worker that the entry does not export.
- ff98301: Module descriptions name their visibility flag `global`, as `ModuleMetadata` (`@Global()`) and `DynamicModule` do.
  
  **Behavior change:** `ModuleDescription.isGlobal` (from `Container.getModuleDescriptions()`, `@velajs/vela/module-kit`) is removed; read `ModuleDescription.global`. The internal `ModuleScope.isGlobal` passed to `Container.registerScope()` (`@velajs/vela/internal`) is renamed `global` too. `vela module graph --json` and the `vela mcp serve` `module_graph`/`token_describe` results report `global` instead of `isGlobal`. The Studio wire protocol moves to version 4 (`STUDIO_PROTOCOL_VERSION`): `app.modules` rows carry `global` instead of `isGlobal` (`ModuleNode.global` in `@velajs/studio-protocol`), so upgrade `@velajs/studio`, `@velajs/studio-host` and `@velajs/studio-ui` together (a host or UI on protocol 3 refuses a protocol-4 application, and the reverse). Studio and CLI 1.31.0 read `isGlobal` and accept core 1.32.0 through their `^1.31.0` peer ranges without a warning: the CLI then reports no module as global, and Studio sends module rows without the `isGlobal` field its protocol-3 UI requires, so upgrade `@velajs/cli` and `@velajs/studio` to 1.32.0 with the core. The `isGlobal` registration extra of `forRoot()` options is unchanged.

### Patch Changes

- `vela generate resource` and the `api` template of `vela new` write decorator routes whose options declare their `response` schemas when the project uses zod, so each route shapes, documents and types its result. Generated POST routes answer 201, and DELETE routes answer 204 through `response: null` instead of `@HttpCode(204)`.
- 38ab1e5: `vela client generate` accepts query parameters documented with `style: form` and `explode: true`, the repeated-key serialization Vela now documents for array query parameters and `hc` sends. A parameter whose schema is a `oneOf` or `anyOf` of values, such as the one value or repeated keys Vela documents for a union or `unknown` named query parameter, is typed as the union of its members (`string | Array<string>`); an object member still fails generation. Other parameter styles, `explode: false` and styled path or header parameters still fail generation.
- Updated dependencies [9dea818]
- Updated dependencies [524e422]
- Updated dependencies [a7d0912]
- Updated dependencies [04e7ac5]
- Updated dependencies [ff98301]
- Updated dependencies [38ab1e5]
- Updated dependencies [38ab1e5]
- Updated dependencies [9c1bd0b]
- Updated dependencies [e412fc8]
- Updated dependencies [bcdf5e3]
- Updated dependencies [d5a8c60]
  - @velajs/vela@1.32.0

## 1.31.0

### Minor Changes

- 2c92243: Add the Cloudflare tooling loop to the CLI, with no configuration file:
  
  - `vela new <name> --template minimal|api --pm pnpm|npm|yarn|bun --install --git`. The `api` template is a zod-validated todos resource stored in Workers KV, a `todo-events` queue processor, a nightly `@Cron` job, `OpenApiModule` serving `/openapi.json`, and workerd specs for each; `--pm` defaults to the package manager running the command.
  - `vela generate` (alias `vela g`) `module|controller|service|resource|queue|cron|durable-object <name>` writes code on the current APIs (application kit, `@velajs/vela/queue`, `@velajs/vela/schedule`, `ENV`, plain decorator routes) and registers it in the parent module (for the root module, the class the Worker entry names, followed through `export { … } from` re-exports and `export *` barrels to the file declaring it, which exports it by name, as `export default AppModule` or in an `export { … as default }` list, else holds a single `@Module()` class), or exports a Durable Object from the Worker entry, by editing the files with `oxc-parser` and `magic-string`, which keep comments on the entries they follow; metadata the CLI cannot edit safely (a computed `@Module()` argument, or a spread or computed key that may set the list) fails with nothing written; a queue adds the `cloudflareQueues()` driver only when no source file configures `QueueModule.forRoot()`; `--skip-import` prints the registration instead.
  - `vela add d1|kv|r2|queue <BINDING>` creates the resource with the project's Wrangler (`--binding --update-config`, and `--config` when given; a queue's producer and consumer are written to a JSON/JSONC Wrangler file and printed for `wrangler.toml`), runs the `types` script and registers the binding: an injection token of a global `BindingsModule`, or `QueueModule.registerQueue({ name, binding })` with the `cloudflareQueues()` driver unless a module configures one. It computes every module edit on the current sources before creating anything and writes them once Wrangler succeeds, so a root module it cannot edit (computed `@Module()` metadata, a spread or computed key that may set `imports`, a re-export of a file that does not exist) or a `bindings.module.ts` that does not parse fails with nothing created or written; a failed `wrangler types` only warns once the binding is registered; `--skip-import` needs no root module.
  - `vela cf sync` compares the Wrangler file with the application's cron triggers, queue producers and consumers, Durable Object bindings and migrations, and Workflows, exiting 1 on differences; `--write` edits JSON/JSONC in place through `jsonc-parser`, one element at a time, keeping comments; `--json` lists the changes as `{ path, value, op: 'append' | 'remove' }`. An added element follows the layout of its array or object: on the line of the last one when that one shares a line (a one-line Wrangler file stays on one line), else on its own line after the comma and comment trailing the last one.
  - Without a `vela.config`, every command reads Wrangler's `main`, loads the `createCloudflareWorker(AppModule)` entry through the Vite module runner (Oxc decorators, `cloudflare:*` resolved to inert Node stand-ins) and builds the application the Worker's descriptor describes, with the Wrangler `vars` as `ENV`; `vela db seed` uses Wrangler's `getPlatformProxy()` local bindings. The commands that build the application accept `--env` (`openapi dump`, `client generate` and `mcp serve` included), and `VelaConfig.rootModule` (like the Worker's root) may be a `DynamicModule`, whose imports and controllers `openapi dump` and `client generate` include.
  
  **Behavior change:** `vela.config` is optional. `resolveConfig()` falls back to `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` in the working directory (`source: 'wrangler'`) instead of failing with "No vela config found", and `loadConfig(cwd, config?, { environment?, bindings?, wrangler? })` returns `{ config, path, source, importModule, dispose }`. Zero-configuration loading needs the `@velajs/cloudflare` release that attaches the Worker descriptor.
  
  **Behavior change:** while a command loads, builds and runs the application, the application's console output (module-scope code of the config or Worker entry and `Logger` lines included) goes to stderr, so stdout carries only the command's output, such as a `--json` document or the MCP stdio channel.
  
  **Behavior change:** `vela deploy check` no longer requires its flags. Without `--config` it reads the Wrangler file in the working directory; without `--env` it checks the top-level configuration (the report's `target.environment` is `null`, and the suggested commands drop `--env`/`CLOUDFLARE_ENV`); without `--entrypoints` it builds the application and computes the snapshot (`provenance.entrypoints` is `{ path: null, computed: true, sha256 }`). Pass `--entrypoints` to keep checking a saved snapshot without importing application code.
  
  **Behavior change:** `vela new` projects no longer contain `vela.config.ts`; the CLI loads their Worker entry. The template moved from `templates/worker` to `templates/minimal` (with `templates/api` and shared files in `templates/shared`). The `dev` and `typecheck` scripts run `wrangler types --include-runtime=false && …` instead of `predev`/`pretypecheck` pre-scripts, so every package manager regenerates the binding types; `pnpm-workspace.yaml` is written for pnpm only. The workerd spec builds the module with `createTestingWorker()` from `@velajs/cloudflare/testing`, so projects pin `@velajs/testing` as a dev dependency. The printed next steps use `<pm> run dev`.

### Patch Changes

- 3fc6f2b: `vela openapi dump`, `vela client generate` and the `vela mcp serve` OpenAPI tool and resource build their documents with the application's `app.getRoutePathOptions()`, so the documented paths match the served routes, including routes a global prefix's `exclude` serves unprefixed, `VERSION_NEUTRAL` routes and a custom versioning `prefix`.
- 088f4d4: `vela client generate` leaves routes marked `@ApiExclude()` out of the generated contract, as the OpenAPI document does, and still checks that every other runtime route is documented.
- Updated dependencies [0b8c649]
- Updated dependencies [1011653]
- Updated dependencies [088f4d4]
- Updated dependencies [f267c2f]
- Updated dependencies [dfe925c]
- Updated dependencies [fd11d20]
- Updated dependencies [748e4f8]
- Updated dependencies [096e259]
- Updated dependencies [fd11d20]
- Updated dependencies [3418c55]
- Updated dependencies [fd11d20]
- Updated dependencies [d51dbb3]
- Updated dependencies [f267c2f]
- Updated dependencies [4a06057]
- Updated dependencies [f267c2f]
- Updated dependencies [1bfc1c1]
- Updated dependencies [f267c2f]
- Updated dependencies [f267c2f]
- Updated dependencies [1ef55ac]
- Updated dependencies [f267c2f]
- Updated dependencies [b227d22]
- Updated dependencies [2c92243]
  - @velajs/vela@1.31.0

## 1.30.0

### Minor Changes

- 4d0342b: Build on the tiered `@velajs/vela` entry points: module-author seams such as `Container`, `MetadataRegistry`, `DiscoveryService`, `PipelineRunner`, trusted request identity and entrypoint scopes come from `@velajs/vela/module-kit`, and features from their subpaths. The package's own exports are unchanged.
  
  **Behavior change:** this release requires the `@velajs/vela` release that introduces `@velajs/vela/module-kit` and the feature subpaths; upgrade both together. Application code that imported these framework names from the root moves them as follows (the `@velajs/vela` changelog lists every name):
  
  | Old import | New import | Examples |
  |---|---|---|
  | `@velajs/vela` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry`, `DiscoveryService`, `createDiscoverableDecorator`, `registerEntrypointKind`, `runInEntrypointScope`, `PipelineRunner`, `RuntimeAdapter`, `invokeScheduledJob`, `getRequestContainer`, `setTrustedRequestIdentity`, `resolveErrorReporter`, `lazyProvider`, `stableHash`, `defineMetadata` |
  | `@velajs/vela` | `@velajs/vela/cache`, `/throttler`, `/schedule`, `/events`, `/health`, `/logging`, `/http-client` | `CacheModule`, `ResponseCacheModule`, `ThrottlerModule`, `ScheduleModule`, `Cron`, `EventEmitterModule`, `HealthModule`, `LoggingModule`, `HttpModule` |
  | `@velajs/vela` | `@velajs/vela/openapi` | `Endpoint`, `defineEndpoint`, `createOpenApiDocument`, `ApiDoc`, `ApiTags`, `ApiResponse` |
  | `@velajs/vela` | `@velajs/vela/security`, `/dispatch` | `SecurityModule`, `CorsModule`, `signUrl`, `NONCE_STORE`; `InternalDispatcher`, `SignedInvocation` |
  | `@velajs/vela` | `@velajs/vela/validation`, `/websocket` | `ValidationPipe`, `defineDto`, `parseSchemaAsync`; `WebSocketGateway`, `WebSocketModule` |
  | `@velajs/vela/internal` | `@velajs/vela/module-kit` | `Container`, `MetadataRegistry` |

### Patch Changes

- Updated dependencies [4467619]
- Updated dependencies [7372d90]
- Updated dependencies [c101033]
- Updated dependencies [4d0342b]
  - @velajs/vela@1.30.0

## 1.29.0

### Minor Changes

- c8d2940: `vela deploy check` checks queues registered with `QueueModule.registerQueue()`. Wrangler `queues.producers` rows now map each binding to its physical queue. Every registered `binding` must be a producer binding of the selected environment (`missing-queue-producer`). When the application consumes natively through `cloudflareQueues()`, each `@Processor` queue must be registered (`unregistered-queue-processor`) and must have a `queues.consumers` entry for the physical queues its registration pins with `consumer`, or else for its binding's producer queue (`missing-queue-consumer`). A processed queue with neither fails with `queue-processor-without-consumer` when the environment consumes no other queue, and otherwise produces an `unverified-queue-consumer` warning. A consumer that no `@QueueConsumer` or processed queue expects fails with `unhandled-queue-consumer`.
  
  **Behavior change:** snapshots listing the removed `cf:queue:producer` kind, or a `cf:queue:module` row with the removed `{ queueName, logicalQueue }` mapping, fail with `stale-entrypoint-snapshot`; regenerate them with `vela entrypoint list --json`. A `cf:queue:module` row no longer counts as a handler for its own physical queue: module consumers are derived from `queue:registration` and `queue` rows.
  
  **Behavior change:** a physical queue claimed by a `@QueueConsumer` that a registration pins with `consumer`, or that any registered queue's producer binding sends to, whether or not the Worker processes that queue, fails with `queue-consumer-claimed-by-raw`, because the raw consumer takes its batches whole and the registered jobs sent there never reach their `@Processor`. An unpinned registered queue whose producer binding sends to a physical queue pinned by other registrations fails with `queue-sent-to-pinned-queue`, because the module consumer rejects its jobs there and Cloudflare dead-letters them. A registration with both a `binding` and `consumer` pins whose producer binding sends to a physical queue outside its pins fails with `queue-producer-outside-pins`, for the same reason; this applies to a producer-only Worker that shares the registration too.
- 0327fb9: **Behavior change:** `vela deploy check` checks Workers cron jobs only through `schedule:cron` rows. A snapshot that lists the removed `cf:scheduled` or `cf:vela-cron` kinds fails with `stale-entrypoint-snapshot` instead of counting them: entrypoint snapshots made by older CLIs must be regenerated with `vela entrypoint list --json`.
  
  **Behavior change:** a `schedule:cron` row without a `dialect` whose weekday field has digits or whose day-of-month and weekday fields are both restricted (for example `0 9 * * 1` or `0 9 1 * MON`) fails with `ambiguous-cron-dialect`: Workers read the trigger with Cloudflare semantics while Node reads it with Vela's unix dialect, so the job fires on different days. Declare `{ dialect: 'cloudflare' }` on the `@Cron`; `{ dialect: 'unix' }` is only for Node-only jobs, which are not deployed as Workers.
  
  **Behavior change:** `vela entrypoint list` adds `guards: true` to the metadata of a `schedule:cron` or `schedule:interval` row whose job declares `@UseGuards` on its class, method or module, and `dispatch: 'signed'` to every scheduled row when `ScheduleModule.forRoot({ dispatch: { kind: 'signed' } })` is configured. `vela deploy check` fails a `schedule:cron` row marked `guards: true` without `dispatch: 'signed'` with `scheduled-job-guards`: guards do not run for directly dispatched scheduled jobs, so the Worker refuses to run the job on every trigger. Use signed dispatch or remove the guard, and regenerate the snapshot.
- 4a166ac: **Behavior change:** `vela new` generates a Worker entry that is only `export default createCloudflareWorker(AppModule)`, with no hand-written environment `InjectionToken`: providers read bindings, variables and secrets through the framework `ENV` (`@InjectEnv()` or `inject: [ENV]`). Generated projects add a `types` script, `wrangler types --include-runtime=false`, which also runs before `dev`, and commit its `worker-configuration.d.ts` so `VelaEnv` carries the bindings declared in `wrangler.jsonc`. They pin `@velajs/vela` and `@velajs/cloudflare` releases that provide `ENV`.
- a07f491: **Behavior change:** when the project installs Vite 8, `loadConfig()` and every command that reads `vela.config.{js,mjs,ts}` load the config, and the relative files it imports, through a Vite module runner with Oxc legacy decorators and decorator metadata; packages still load from `node_modules`, and neither the project's Vite config nor tsconfig path aliases apply. A config can therefore import decorated TypeScript source directly, at the top level or lazily from `createApp()` (`await import('./src/app.module.js')`): the runner stays open for the whole command and closes after the app is disposed. `vite` is a new optional peer dependency. Without it, Node imports the config as before, and the load error now explains how to install Vite or import compiled `.js` files.
  
  **Behavior change:** `loadConfig()` now resolves to `{ config, path, dispose }` (the new `LoadedVelaConfig` type) instead of the config itself. Call `config.createApp()` as before, then `await dispose()` once the app is disposed to close the module runner that loaded the config.
- a07f491: **Behavior change:** `vela new` generates a Vite 8 project instead of an SWC precompile. `pnpm dev` runs `vite dev` (Vite's port, 5173), `pnpm build` runs `vite build`, `pnpm preview` serves the build, and `pnpm run deploy` runs `vite build && wrangler deploy`, all through `@cloudflare/vite-plugin`. Vite's Oxc transformer emits the legacy decorators and `design:paramtypes` metadata that constructor injection needs, from options stated once in `oxc.config.ts` and imported by both `vite.config.ts` and `vitest.config.ts`. `wrangler.jsonc` points `main` at `src/worker.ts`, drops the `build` block, and sets no compatibility flags: its compatibility date enables Node.js compatibility, including `node:async_hooks`, by default. The `.swcrc` file, the `@swc/*` dependencies and the lint suppression in `src/app.controller.ts` are gone, and `tsconfig.json` (which keeps `verbatimModuleSyntax` and `isolatedModules`, since Oxc compiles one file at a time) also checks the tests and config files.
  
  Generated projects now include `test/worker.spec.ts`, which `pnpm test` runs inside workerd with `@cloudflare/vitest-plugin`; it calls the Worker's `fetch` handler and reads the body before waiting on the execution context. They pin `@velajs/cli` as a dev dependency, so `pnpm vela route list` works without a separate install, and their `vela.config.ts` imports the decorated `src/` files instead of a `dist/` build. The committed `worker-configuration.d.ts` lets a fresh checkout typecheck; `pnpm dev` and `pnpm typecheck` regenerate it first (the Wrangler file has no `build` block, so `wrangler types` runs no build), and `pnpm types` regenerates it on demand.
  
  **Behavior change:** for a project the Cloudflare Vite plugin builds, one with the `.wrangler/deploy/config.json` redirect a Vite build writes or a `vite.config.*` beside the Wrangler file that references `@cloudflare/vite-plugin`, `vela deploy check` suggests `cd '<dir>' && CLOUDFLARE_ENV=<env> pnpm build && pnpm exec wrangler deploy --env <env> --dry-run` as its next step, and its `--json` report adds the build as `nextStep.build` (`{ command, args, env, cwd }`). It previously suggested `wrangler deploy --config <file> --env <name> --dry-run`, which bypasses the Vite build and bundles the source with esbuild, without decorator metadata. Wrangler checks the kept `--env` against the environment the build targeted. Checking a Wrangler file with another name than `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` adds a `vite-config-path` warning, since the plugin reads those unless its `configPath` option names the file. Other projects keep the `--config` suggestion. Every next step now runs in the Wrangler file's directory: the printed command starts with `cd '<dir>' &&`, and the JSON steps carry it as `cwd`, so a check run from a parent directory suggests commands that resolve the project's own scripts and Wrangler.

### Patch Changes

- 53e8f43: `vela client generate` no longer fails with `OpenAPI is missing ALL ...` on an application with an `@All` route, such as the Better Auth catch-all handler. OpenAPI has no operation for `ALL`, so the check that the document covers every application route now skips those routes, as the document itself does.
- Updated dependencies [07d1713]
- Updated dependencies [db18d3a]
- Updated dependencies [07d1713]
- Updated dependencies [bacaacd]
- Updated dependencies [a814199]
- Updated dependencies [1838474]
- Updated dependencies [8a3016c]
- Updated dependencies [d803a49]
- Updated dependencies [b235935]
- Updated dependencies [08a81c8]
- Updated dependencies [5b5b81d]
- Updated dependencies [7daf4fc]
- Updated dependencies [35e8e0d]
- Updated dependencies [4420501]
- Updated dependencies [ff44b6a]
- Updated dependencies [6d4f0c0]
- Updated dependencies [e3bda2a]
- Updated dependencies [bd7e3c9]
- Updated dependencies [2b74880]
- Updated dependencies [5ba8635]
- Updated dependencies [db0c834]
- Updated dependencies [d6f6a65]
- Updated dependencies [8a3016c]
- Updated dependencies [d5a3ec8]
- Updated dependencies [0f7e8e7]
- Updated dependencies [41ec70d]
- Updated dependencies [b265297]
- Updated dependencies [bdfff47]
- Updated dependencies [28c7d07]
- Updated dependencies [8a3016c]
- Updated dependencies [44efdde]
  - @velajs/vela@1.29.0

## 1.28.0

### Minor Changes

- Continue the module-based Workers APIs on the 1.x release line. Vela permits breaking changes in minor releases and does not retain compatibility layers. Upgrade the framework and integrations together for native queue dispatch, cron scheduling, RPC modules and asynchronous roots; see docs/module-workers.md.

### Patch Changes

- Updated dependencies
  - @velajs/vela@1.28.0

## 3.0.0

### Major Changes

- Publish module-based Workers on the unused 3.x stable release line. Earlier experimental 2.0.0 registry versions are immutable and do not contain this release. Upgrade the framework and integrations together; see docs/module-workers.md for queue bootstrap, native delivery, RPC modules and async root migration details.

### Patch Changes

- Updated dependencies
  - @velajs/vela@3.0.0

## 2.0.0

### Major Changes

- a2d2692: Require the Vela 2 module/runtime peer line. Packages that raise their framework or adapter peer requirement ship a major version so existing 1.x installations are not offered an incompatible patch release. Upgrade the related framework integrations together; native queue/bootstrap migration is documented in docs/module-workers.md.

### Minor Changes

- b99d71a: Compose native Worker applications through modules. QueueModule now initializes transport configuration at bootstrap and publishes driver-owned native routes, removing application-written consumer bridges. Duplicate queue ownership fails at startup. Cloudflare rejects deliveries without a consumer instead of silently accepting them; existing native decorators and envelopes remain supported.
  
  Cloudflare roots accept dynamic modules and asynchronous factories. RPC server modules and injectable named clients reuse the existing schema-validated dispatcher. Deployment checks validate module queue mappings, producer declarations and RPC service bindings. A four-worker example and exact-archive runtime proof cover composition, native delivery and scheduling.

### Patch Changes

- Updated dependencies [b99d71a]
  - @velajs/vela@2.0.0

## 1.26.1

### Patch Changes

- 7f7b421: Update generated Worker projects to core 1.27.0 and Cloudflare 1.24.0 so new applications use the current framework APIs and execution lifetimes. Keep exact dependency pins and install generated projects from the public npm registry.

## 1.26.0

### Minor Changes

- 2addbe3: Add binary, streaming and native Response endpoint contracts with explicit media types and OpenAPI metadata. Native responses preserve their status, headers and body; stream handling retains backpressure, cancellation and producer errors without buffering.
  
  Generate native HTTP client contracts with unknown JSON results and add response, blob and stream consumption helpers. Existing JSON/text responses and multipart/URL-encoded request contracts retain their behavior.

### Patch Changes

- Updated dependencies [2addbe3]
- Updated dependencies [2addbe3]
- Updated dependencies [2addbe3]
  - @velajs/vela@1.27.0

## 1.25.0

### Minor Changes

- 4a6f5df: Add schema-bound multipart and URL-encoded endpoint bodies with native files,
  repeated fields, explicit bounded parsing, and matching OpenAPI contracts. Generate
  accurate form request types and encoding metadata, with an opt-in HTTP fetch adapter
  that preserves caller transports and request options. Existing JSON endpoints and
  Hono client exports remain compatible.

### Patch Changes

- Updated dependencies [efdf854]
- Updated dependencies [4a6f5df]
  - @velajs/vela@1.26.0

## 1.24.0

### Minor Changes

- 2c1cac6: Add read-only `vela doctor` config provenance and opt-in application snapshots.
  Validate imported configs and Studio ports and preserve inferred config subtypes.
  Generate a Node-side config
  that imports the starter's SWC output, and explain the decorator/compiler boundary.
- 50358a1: Add read-only `vela deploy check` for explicit Wrangler environments and saved entrypoint snapshots. Validate configuration, cron and queue alignment, and WebSocket Durable Object bindings; report redacted target information and git/input provenance without constructing applications, running custom builds or uploading code.
- 4fde903: Discover seeders per owning module registration and await async resolution inside
  managed invocation scopes. Preserve sequential ordering and stop/continue behavior
  while settling deferred work before disposal. Add optional module ownership to
  seeder inventories and expose it through `vela db seed --list --json` without
  executing seeders.

### Patch Changes

- 6d33ac9: Dispose applications after seeder registry or command failures, preserving the
  primary result when cleanup fails. Share command lifetime handling across
  introspection, client generation and MCP, including cleanup of older 1.x apps
  whose shutdown hooks throw.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

## 1.23.0

### Minor Changes

- 23c7808: Add `vela new <name>` to create a minimal Cloudflare Workers application with a module, controller, and constructor-injected service. Include published npm dependencies, TypeScript and SWC decorator configuration, Wrangler source rebuilds, pnpm scripts, and a short runnable README. Reject invalid names and nonempty destinations without overwriting files. Report the actual package version from `vela --version`.

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/studio-host@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Schema-driven Hono client generation and the local Vela Studio host command. Generated contracts preserve unknown types where a response schema is absent.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- faef8b1: Require the Vela 1.21 runtime so generated and inspected applications use the coordinated security-boundary release.

## 0.3.2

### Patch Changes

- 1e1ec9c: Modernize the package build, validation, and release toolchain.
