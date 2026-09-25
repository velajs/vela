# Development tooling

Vela uses one pnpm workspace, lockfile, and dependency catalog. Root commands
apply shared lint and formatting configuration across packages and applications.

| Task | Tool | Implementation |
| --- | --- | --- |
| Typechecking | TypeScript 7 | Native Go compiler |
| Linting | Oxlint | Rust |
| Formatting | Oxfmt | Rust |
| Library bundling | tsdown | TypeScript orchestration over Rust Rolldown/Oxc |
| Worker builds | Vite 8 with `@cloudflare/vite-plugin` | Rust Rolldown/Oxc |
| Decorator metadata | Oxc (Vite, tsdown); SWC in package test suites | Rust |
| Tests | Vitest with Oxc, SWC or the Workers plugin | JavaScript runner with native transforms or Workerd |

Versions are pinned in the root `pnpm-workspace.yaml` catalog. Oxc emits the
legacy decorator metadata used by constructor injection in Worker builds and the
published package bundles; several package test suites still compile with SWC
through `unplugin-swc`. TypeScript checks source and public declarations
separately from bundling.

## Build pipeline

Applications build with Vite 8 and `@cloudflare/vite-plugin`: `vite dev` runs the
Worker in the local Workers runtime, `vite build` writes the deployable Worker,
and Vitest runs Workers tests with `@cloudflare/vitest-plugin`. Vite compiles
TypeScript with its built-in Oxc transformer, with no separate SWC step. The
`vela new` starter is the reference setup:

```ts
// oxc.config.ts: one setting for the build and the tests.
export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];

// vite.config.ts
export default defineConfig({ oxc, plugins: [cloudflare()] });

// vitest.config.ts
export default defineConfig({
  oxc,
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
```

Oxc emits `design:paramtypes` like SWC: an imported class becomes
`typeof X === "undefined" ? Object : X`, and an interface or a type-only import
becomes `Object`. The container rejects such an `Object` parameter without
`@Inject(token)` at registration with `MissingInjectionMetadataError`.

Keep these rules when you configure a project yourself:

- **Pass the Oxc decorator options explicitly** in both the Vite and the Vitest
  config. Vite can infer them from `experimentalDecorators` and
  `emitDecoratorMetadata` in `tsconfig.json`, but only for files that tsconfig
  includes; any other file (a test, a script, a file outside `include`) is then
  compiled as a TC39 decorator and fails with a syntax error.
- **Keep `cloudflare()` out of the Vitest config.** `cloudflareTest()` runs the
  tests in workerd; the Vite plugin belongs to `vite.config.ts` only.
- **Read a response body before `waitOnExecutionContext(ctx)`** in Workers
  tests: a request finishes only once its body is consumed.
- **Enable `verbatimModuleSyntax` and `isolatedModules`** in the application
  tsconfig. Oxc compiles one file at a time, so it keeps a plain
  `import { Options }` of an interface used in a decorated signature, and the
  module then fails to link; with these flags TypeScript reports that import
  (TS1484). Import the classes you inject as values: `import type` erases their
  metadata, which the container rejects at registration.
- **Keep class names if you minify.** Vite does not minify the Worker by default;
  with `build.minify` on, set `build.rolldownOptions.output.keepNames: true`.
- **`.dev.vars` is copied into the build output** for `vite preview`; do not
  publish `dist/` beyond `wrangler deploy`.
- **Deploy the Vite output.** `wrangler deploy` without `--config` follows the
  redirect `vite build` writes; `--config wrangler.jsonc` makes Wrangler bundle
  `src/` with esbuild, which emits no decorator metadata. See
  [deployment](deployment.md#build-with-vite).

`@velajs/cli` loads application code through a Vite module runner that stays
open for the whole command, with the same Oxc options, when the project installs
Vite 8 (an optional peer of the CLI), so it imports decorated `src/` files
directly; see [the CLI loop](#the-cli-loop). Without Vite, the CLI imports files
with Node, which does not transform decorators.

If Oxc cannot build a project, use SWC inside Vite with
[`unplugin-swc`](https://github.com/unplugin/unplugin-swc) as a fallback: set
`oxc: false` and add
`swc.vite({ tsconfigFile: false, swcrc: false, jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, keepClassNames: true } })`
before `cloudflare()` (or `cloudflareTest()` in the Vitest config).

## The CLI loop

`@velajs/cli` covers a Workers project from creation to deployment without a
configuration file:

```sh
vela new my-api --template api --pm pnpm --install --git
vela generate resource notes            # alias: vela g
vela add kv CACHE
vela cf sync --write
vela deploy check
```

- **Loading the application.** Without a `vela.config`, the CLI reads `main`
  from `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` (`--env` selects a
  named environment) and imports that entry through the Vite module runner.
  The Worker of `defineCloudflareApp(AppModule, options)` (and
  `createCloudflareWorker(AppModule, options)`) attaches a descriptor under
  `Symbol.for('vela.cloudflare.worker')`, from which the CLI builds the same
  application the Worker builds; it also lists the Durable Object classes
  defined from the app, and each class `VelaDurableObject()` or
  `VelaWebSocketDurableObject()` builds carries its own descriptor under
  `Symbol.for('vela.cloudflare.durableObject')`. `cloudflare:*` modules resolve
  to inert Node stand-ins through a Node module hook, so the entry may export
  Durable Object and Workflow classes. Listing commands (`route list`, `module graph`,
  `entrypoint list`, `openapi dump`, `client generate`, `doctor --app`,
  `deploy check`, `cf sync`) seed `ENV` with the Wrangler `vars` only; `db seed`
  uses Wrangler's `getPlatformProxy()` local bindings. A `vela.config` in the
  working directory takes precedence. While a command loads and runs the
  application, its console output (module-scope code of the config or Worker
  entry and `Logger` lines included) goes to stderr, so `--json` output and
  the `mcp serve` channel on stdout stay machine-readable.
- **Generators.** `vela generate module|controller|service|resource|queue|cron|durable-object <name>`
  writes current-API code (the root application kit, `@velajs/vela/queue`,
  `@velajs/vela/schedule`, `ENV`, plain decorator routes) and registers it:
  module files are parsed with `oxc-parser` and edited with `magic-string`, so
  only the changed spans move. The root module is the class the Worker entry
  names, followed through `export { … } from` re-exports and `export *`
  barrels to the file declaring it (exported by name, as
  `export default AppModule` or in an `export { … as default }` list, else
  that file's only `@Module()` class); in other module files the edited class
  is the one the file exports. Metadata with a computed argument, or with a
  spread or computed key that may set the list being extended, is refused with
  nothing written: an entry added there would replace the spread list or be
  replaced by it. `queue` adds
  `QueueModule.forRoot({ driver: cloudflareQueues() })` to the root module only
  when no source file configures the driver yet. `durable-object` writes an
  `@Injectable()` host (`counter.host.ts`, injecting `DO_STORAGE`) and the
  class the Worker entry exports, whose `rpc` option lists the host's RPC
  methods. When the entry binds its app (`const app = defineCloudflareApp(...)`),
  the class is declared in the entry after it,
  `export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}`,
  so it shares the app's runtime adapters; when the entry imports the app from
  its own module, `counter.durable-object.ts` imports it too. Otherwise the
  class is built from the root module the entry names, in
  `counter.durable-object.ts`, and the generator says so when the entry passes
  options the class then does not share (see
  [Durable Objects](durable-objects.md)). `--skip-import` prints the
  registration instead.
  TypeScript 7 has no stable compiler API, which is why the CLI uses Oxc here.
- **Resources.** `vela add d1|kv|r2|queue <BINDING>` wraps
  `wrangler <resource> create --binding --update-config` (queues:
  `wrangler queues create`, then the producer and consumer are written to the
  Wrangler file), runs the project's `types` script and registers the binding.
  `--config` is passed on to Wrangler; with a Wrangler file other than the
  default one, the `types` script (which reads the default file) is left for
  you to run against it. Every module edit is computed on the current sources
  before anything is created and written once Wrangler succeeds, so a root
  module the CLI cannot edit (computed `@Module()` metadata, a spread or
  computed key that may set `imports`, a re-export of a file that does not
  exist) or a `bindings.module.ts` that does not parse fails
  with nothing created or written; a failed `wrangler types` only warns.
  `--skip-import` needs no editable root.
- **Wrangler sync.** `vela cf sync` derives cron triggers, queue producers and
  consumers, Durable Object bindings and migrations, and Workflows from the
  application and the Worker entry's exports. A gateway binding no class serves
  is paired with the one exported `VelaWebSocketDurableObject` class without a
  binding, never with a host Durable Object, and a Durable Object class the app
  defines but the entry does not export is reported. It exits 1 on differences, and
  `--write` edits JSON/JSONC through `jsonc-parser`, one element at a time
  (a cron trigger is appended or removed on its own), keeping comments. An
  added element follows its array's or object's layout: on the line of the
  last one when that one shares a line (a one-line Wrangler file stays on one
  line), else on its own line after the comma and comment trailing the last
  one.
- **Deployment check.** `vela deploy check` defaults to the Wrangler file in the
  working directory and its top-level configuration, and computes the
  entrypoint snapshot from the application unless `--entrypoints` names a saved
  one. See [deployment](deployment.md).

`scripts/cli-consumer.mjs` verifies the packed CLI end to end: it scaffolds
both templates, installs them from the release archives, runs every generator,
`cf sync --write`, the type check, the workerd specs, `deploy check`, the Vite
build and the dev server. The templates pin the workspace versions
(`scripts/starter-pins.mjs`), which `pnpm check:workspace` enforces and
`pnpm version-packages` updates.

## Commands

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm verify
```

Use `pnpm --filter <package> <command>` for focused work. The root `pnpm verify`
command also runs cross-package conformance and native Workers tests.
`pnpm check:skill` typechecks every `ts` code block of the package READMEs and
the bundled agent skill against the built packages (after `pnpm build`). Each
block compiles as its own module, retried as class members or a function body
when it is a fragment; names a fragment leaves undeclared are tolerated, while
missing packages, subpaths or exports and mismatched signatures fail. Mark a
block that shows invalid code on purpose with ```` ```ts nocheck ````.

## API documentation

The documentation website uses Fumadocs in the separate private
[velajs/site](https://github.com/velajs/site) repository. The TanStack Start and
Cloudflare Workers application uses TypeScript 7 for site checking, build-time API
tables, and Twoslash examples with type hovers. It reads exact published Vela
package versions. The compiler runs only during the build; the deployed Worker
does not include it.

The MDX guides live in the private [velajs/docs](https://github.com/velajs/docs)
repository, pinned by the site as a Git submodule. From a site checkout with that
content initialized, run:

```sh
pnpm install --frozen-lockfile
pnpm check
```

This checks types and generated references, builds and prerenders the site, and
runs local Worker smoke tests for pages, tables, hovers, search, and 404s. Commit
and push content changes before updating the site's submodule pointer. Updating
content and npm dependencies, checking the site, and deploying it are separate
from publishing framework packages.

The website provides guides and focused tables for module options, dynamic
modules, and Worker options. It does not generate a page for every exported class,
decorator, method, overload, or entrypoint. The standalone automatic API reference
is no longer produced. Consult package READMEs, source-adjacent guides, and
published TypeScript declarations for APIs beyond the selected tables.

OpenAPI documents and typed HTTP clients are generated from application contracts
independently of the website. Framework builds, decorator compilation, and API
snapshot checks remain part of this workspace's validation.

## OpenAPI

An application serves its OpenAPI 3.1 document by importing `OpenApiModule` from
`@velajs/vela/openapi`:

```ts
@Module({
  imports: [
    OpenApiModule.forRoot({ path: '/openapi.json', info: { title: 'API', version: '1.0.0' } }),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

The document covers the application root (`ROOT_MODULE`), including routes that
route contributors such as `@Crud()` document, under the application's global
prefix. It does not read the application's `globalPrefixOptions` or `versioning`:
when the application excludes routes from the prefix or sets `versioning.prefix`,
pass the same `globalPrefixOptions` and `versioning` to `OpenApiModule.forRoot()`
so the document's paths match the served routes. The document is built on the
first request and kept for that application, so each Workers environment
documents its own application. The document route is served
at `path` exactly as given, outside the global prefix, runs no guards, and is
left out of the document itself. `forRoot` also accepts `tags`, `servers`,
`securitySchemes` and `security`; `forRootAsync` reads them through DI. Mark a
controller or handler with `@ApiExclude()` to leave it out of the document and
the generated client while still serving it.

`vela openapi dump` writes the same document from `vela.config.ts`, and
`vela client generate` turns it into a typed `hc` contract; see
[the HTTP client guide](client/HTTP.md). `createOpenApiDocument(root, options)`
remains available for custom serving, and `app.mountOpenApi()` serves a built
document with the Scalar, Swagger UI or ReDoc pages.

## Release artifacts

Release scripts write tested archives, their integrity manifest, and consumer
verification to `.artifacts/release/`. npm's local release cache uses `.cache/npm/`.
Both directories are ignored by Git. See [the release guide](../RELEASING.md) for
publication and recovery.
