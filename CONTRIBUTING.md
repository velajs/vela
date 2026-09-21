# Contributing to Vela

Vela provides modules, controllers, dependency injection, and request pipelines
for Cloudflare Workers. Propose changes around a concrete application use case;
keep native Workers bindings accessible and optional integrations independent.

## Development setup

Use Node 24 or later and pnpm 11.11.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Libraries live in `packages/`, runnable examples in `apps/`, shared tooling in
`tools/`, and cross-package tests in `tests/`. Use the root workspace and lockfile.
Shared tool versions belong in the `pnpm-workspace.yaml` catalog.

The [API starter](apps/api-starter/README.md) demonstrates the complete Workers
development flow. Package READMEs cover installation and package APIs; shared
guides live in [docs/](docs/README.md).

## Making a change

Keep each pull request focused on a user-visible behavior or a maintenance need.
Explain the problem, the resulting behavior, and how you verified it. Include a
small reproduction for bugs and regression coverage for changed behavior.

Use Web APIs in portable runtime code. Keep Node-specific code in explicit Node
entrypoints, development tools, or tests. Validate external input and preserve
request and environment isolation. Changes to public APIs must update affected
examples and documentation together.

Run focused checks while developing:

```sh
pnpm --filter @velajs/vela test
pnpm --filter @velajs/cloudflare test:workers
pnpm test:conformance
```

Before submitting, run `pnpm lint` and `pnpm verify`. The verification gate checks
the workspace, builds, API snapshot, types, bundled skill documentation, package
tests, release tests, CRUD conformance, and native Workers behavior. Review
intentional core API changes with `pnpm --filter @velajs/vela api:update`.

The Fumadocs website is maintained separately in the private
[velajs/site](https://github.com/velajs/site) repository, with MDX content from
[velajs/docs](https://github.com/velajs/docs). Run `pnpm check` from the site
checkout for website or content changes; see [the tooling guide](docs/tooling.md).

## Versions and releases

For a change that needs a package release, run `pnpm changeset` and describe its
effect on consumers. Documentation-only and repository-tooling changes do not
require a version bump. The active release line is 1.x.

Maintainers prepare versions and publish through the process in
[RELEASING.md](RELEASING.md). CI verifies the exact package archives before public
npm publication through GitHub OIDC with signed provenance. Never commit tokens,
local credentials, generated release archives, or internal task notes.
