# Native tooling and the Nestm comparison

The local Nestm repositories use pnpm workspaces with `packages/*`, `apps/*`,
Oxlint, TypeScript 7, SWC where decorators need metadata, and tsdown for several
libraries. Nestm also uses `oxlint-tsgolint` for type-aware linting. Some packages
still build with `tsc`, and formatting uses Prettier; it is not an all-Rust stack.

Vela already used Oxlint, Oxfmt, tsdown, SWC, and TypeScript 7 before this layout
migration. This change centralizes lint/format configuration and exposes root
commands while keeping the tested compiler and bundler versions in one catalog.
No speedup is claimed without a comparable benchmark. Vitest and package scripts
still have JavaScript coordination overhead; a native transformer does not make
the complete test runner native.

| Task | Vela tool | Implementation |
| --- | --- | --- |
| Typechecking | TypeScript 7.0.2 | Native Go compiler |
| Linting | Oxlint | Rust |
| Formatting | Oxfmt | Rust |
| Library bundling | tsdown | TypeScript orchestration over Rust Rolldown/Oxc |
| Decorator metadata | SWC | Rust |
| Tests | Vitest + SWC / Workers plugin | JS runner with native transforms / Workerd |

SWC remains necessary for legacy decorator metadata in the tested DI setup.
Type-aware Oxlint can be adopted separately after evaluating its diagnostics;
this migration retains the existing rule policy and explicit TS7 typechecks.

TypeDoc 0.28 does not support the TypeScript 7 native compiler API yet. Its
TypeScript 6 dependency lives only in the private `tools/docs` project. API docs
explicitly use the core package tsconfig, so moving the docs tool cannot silently
lose decorator settings.

Primary references: [Oxc](https://oxc.rs/docs/guide/usage/linter/type-aware.html),
[tsdown](https://tsdown.dev/guide/), [SWC](https://swc.rs/),
[TypeScript native compiler](https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/),
and [TypeDoc TS7 tracking](https://github.com/TypeStrong/typedoc/issues/3098).
