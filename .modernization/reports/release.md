# Release preparation — 2026-09-20

The accepted follow-up is implemented: complete D1/auth/CRUD/generated-client/live
starter, explicit Studio live inspection, packed consumers, staging smoke, and
coordinated 2.0 release artifacts for 21 public packages.

## Verified

- `release-final-verify.log`: exit 0, 3,310 tests, builds and all configured types.
- `release-consumer.log`: fresh npm install outside the workspace from tarballs;
  starter build/types/client consistency and Wrangler bundle pass.
- `release-all-publint.log`: every public package passes publint.
- `release-publish-preflight.log`: archive integrity and publication order pass.
- `release-peers.log`: no peer dependency issues.
- `release-local-smoke.log` and `release-staging-smoke.log`: auth, D1 CRUD,
  live create/update/delete, Studio models/subscriptions/presence pass.
- Browser: sign-in, generated-client create/update, two sessions, and Studio Live
  table verified. Local browser smoke account and task cleaned up.
- npm login verified as the owner of the velajs organization.

Staging is <https://vela-api-starter-staging.labo.workers.dev>. It uses Worker
`vela-api-starter-staging` and its own D1 database with the same name. Its generated
secrets are in an ignored local file with mode 0600 and Cloudflare secret bindings.

## Monorepo follow-up

The user selected consolidation in `velajs/vela`. The root now owns the Git
repository, package histories, workspace/lockfile, CI, and release scripts.
See `docs/migration/monorepo.md` and `imports.json` for the import record.
The verification above describes the pre-conversion baseline; new monorepo
verification logs use `.modernization/monorepo-*.log`.

## Limits

The shared board is explicitly shared among signed-in users. It is not a tenant
isolation example. General CRUD responses without a declared response schema stay
`unknown`; the app renders rows parsed by its shared live schema. Inspection is
scoped to explicitly supplied engines/room stubs, and contains operational
metadata rather than query arguments, result payloads, or identity claims.

AI/agent/mail/workflow/event-source/site work was not included in this release.
MySQL has not been tested against a real database.

## Monorepo verification

- Full root verification passed: 3,314 tests, types, builds, API snapshot, skill
  metadata and TypeDoc checks.
- Peer dependency check passed; dependency audit has no high/critical findings
  (two moderate advisories remain).
- 441 imported commits scanned with Gitleaks. Two exact fingerprints are ignored
  for reviewed synthetic test fixtures; no other findings remain.
- All 21 public package manifests now point to their `velajs/vela` directory.
