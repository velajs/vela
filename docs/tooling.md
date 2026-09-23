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

`vela.config.ts` is loaded by `@velajs/cli` through a Vite module runner that
stays open for the whole command, with the same Oxc options, when the project
installs Vite 8 (an optional peer of the CLI), so the config can import decorated
`src/` files directly. Without Vite, the CLI
imports the config with Node, which does not transform decorators.

If Oxc cannot build a project, use SWC inside Vite with
[`unplugin-swc`](https://github.com/unplugin/unplugin-swc) as a fallback: set
`oxc: false` and add
`swc.vite({ tsconfigFile: false, swcrc: false, jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, keepClassNames: true } })`
before `cloudflare()` (or `cloudflareTest()` in the Vitest config).

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

## Release artifacts

Release scripts write tested archives, their integrity manifest, and consumer
verification to `.artifacts/release/`. npm's local release cache uses `.cache/npm/`.
Both directories are ignored by Git. See [the release guide](../RELEASING.md) for
publication and recovery.
