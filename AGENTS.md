# Vela monorepo

Use Node 24+ and pnpm 11.11.0 from this root. All active packages share
`pnpm-workspace.yaml` and `pnpm-lock.yaml`. Do not create package-local lockfiles
or release workflows. Use `pnpm --filter <package> <command>` for focused work.

Build a NestJS-style developer experience on Cloudflare Workers. Keep application
authoring simple and optional integrations independently usable. The release line
is 1.x. Breaking API changes must update affected examples and documentation.

Keep portable framework runtime code on Web APIs. Node APIs belong only in
explicit Node entrypoints, CLI/Studio host, build scripts, and tests. Cloudflare
modules may use native Workers APIs. Preserve request/environment isolation and
validate external values before assigning domain types.

Run relevant package types/tests when editing behavior. `pnpm verify` is the
integration gate. Before publishing, run `pnpm release:check` and test the exact
packed archives with `pnpm release:consumer`; see `RELEASING.md`.

Use CONTRIBUTING.md for contributor workflow and RELEASING.md for publication.
Keep task plans, session notes, and generated reports out of the repository.
