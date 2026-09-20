# Monorepo migration — 2026-09-20

`velajs/vela` now owns the API framework, Cloudflare adapter, CLI, clients,
authentication/authorization, CRUD, storage, feature flags, testing, and Studio.
The first conversion preserved package paths. The subsequent layout migration
places libraries in `packages/`, maintained examples in `apps/`, shared tooling
in `tools/`, and conformance suites in `tests/`. Development uses a single root
Git repository, pnpm workspace, lockfile, CI, and Changesets configuration.

## History

The conversion commit descends from the previous `velajs/vela` main and each
imported repository head. Original commit identities remain reachable, including
the fetched remote main branches. `imports.json` records source URLs, prior local
heads, remote heads, modernization checkpoints, and reconciled import heads.
Historical commits retain their original repository-relative paths; use the
recorded import head to browse them, for example `git show <importHead>:src/index.ts`.

Complete Git bundles and the original nested Git metadata are also retained in
the ignored local `.modernization/monorepo-backup/` directory. These backups are
not required to clone or build this monorepo. Imported repositories were not
archived or rewritten on GitHub.

Upstream Cloudflare Access principal fixes are retained by the stronger shared
verified-identity implementation. New feature-flag fixes preserve trusted identity
context, reject malformed boolean verdicts and inherited manifest keys, and deny
route access on evaluation errors. Regression tests cover these boundaries.

## Development and releases

Run install/build/verify from the root. Package-specific commands use pnpm filters.
CI verifies the full graph, native Workers tests, package artifacts and an npm
consumer outside the workspace. The separate TypeDoc toolchain is a private
workspace project and uses the same lockfile. Root security workflows retain
secret scanning and dependency advisory checks.

Existing pending changeset notes are consumed by the coordinated 2.0 release and
archived in `2.0-changesets/`. Future changesets belong in the root `.changeset/`.
No package-local publication workflow remains. See `RELEASING.md`.

Agent, AI, mail, workflow, event-source and site repositories remain deferred and
excluded. Local secrets, generated artifacts, package caches and original Git
metadata are ignored.

## Historical examples

The workspace includes maintained applications through `apps/*`. Older standalone examples
(`auth-lab`, `auth-lab-plugins`, `harbor-crud-api`, `multi-tenant-wiring`,
`di-playground-api`, `evergreen-market-api`, and `scheduler-node-jobs`) remain under `examples/legacy` as
historical source. Their old independent lockfiles remain in imported history,
so the working tree has only the root lockfile. These examples are
not part of the 2.0 verification or release. Start new work from the maintained
`apps/api-starter` rather than those historical examples.
