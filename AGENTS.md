# Vela monorepo

Use Node 24+ and pnpm 11.11.0 from this root. All active packages share
`pnpm-workspace.yaml` and `pnpm-lock.yaml`. Do not create package-local lockfiles
or release workflows. Use `pnpm --filter <package> <command>` for focused work.

`DESIGN.md` defines the intended NestJS-style developer experience on Cloudflare
Workers independently of the existing implementation and package count.
Keep the current release on 1.x. Breaking API changes are allowed; update the
maintained apps rather than preserving obsolete examples or compatibility layers.

Keep portable framework runtime code on Web APIs. Node APIs belong only in
explicit Node entrypoints, CLI/Studio host, build scripts, and tests. Cloudflare
modules may use native Workers APIs. Preserve request/environment isolation and
validate external values before assigning domain types.

Run relevant package types/tests when editing behavior. `pnpm verify` is the
integration gate. Before publishing, run `pnpm release:check` and test the exact
packed archives with `pnpm release:consumer`; see `RELEASING.md`.

Deferred agent/AI/mail/workflow/event-source/site repositories and local backups
are outside this monorepo. Do not add or modify them as part of API changes.
