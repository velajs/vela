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

TypeDoc uses the TypeScript compiler API. Its TypeScript 6 dependency is isolated
in the private `tools/docs` project; package builds and typechecks use TypeScript
7. Documentation uses the core package tsconfig, including its decorator settings.

Run `pnpm docs` to generate API documentation and `pnpm docs:check` to validate it.

## Release artifacts

Release scripts write tested archives, their integrity manifest, and consumer
verification to `.artifacts/release/`. npm's local release cache uses `.cache/npm/`.
Both directories are ignored by Git. See [the release guide](../RELEASING.md) for
publication and recovery.
