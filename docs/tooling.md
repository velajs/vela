# Development tooling

Vela uses one pnpm workspace, lockfile, and dependency catalog. Root commands
apply shared lint and formatting configuration across packages and applications.

| Task | Tool | Implementation |
| --- | --- | --- |
| Typechecking | TypeScript 7 | Native Go compiler |
| Linting | Oxlint | Rust |
| Formatting | Oxfmt | Rust |
| Library bundling | tsdown | TypeScript orchestration over Rust Rolldown/Oxc |
| Decorator metadata | SWC | Rust |
| Tests | Vitest with SWC or the Workers plugin | JavaScript runner with native transforms or Workerd |

Versions are pinned in the root `pnpm-workspace.yaml` catalog. SWC emits the
legacy decorator metadata used by constructor injection. TypeScript checks
source and public declarations separately from bundling.

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
