# Vela releases

The user's clarified product target and independent acceptance criteria are in
[DESIGN.md](DESIGN.md). The archives below are a verified implementation snapshot;
their package count and passing tests do not settle the public product structure.

The active release line is 1.x. Version 1.22.1 coordinates all 21 public workspace
packages, the apps/packages layout, TypeScript 7, and npm OIDC publication with
signed provenance from the public source repository.
Breaking changes are accepted during this development phase; applications should
use the current APIs described below. Release titles use plain versions, such as
`Vela 1.22.1`, without layout or migration suffixes.

Earlier 2.x versions were already submitted to npm before the release-line
decision changed. Those versions remain historical registry entries; the 1.x
release is published explicitly to `latest`.
`release-plan.json` is the package/version manifest. Deferred AI, agent, mail,
workflow, event-source, and site repositories are not part of this release.

## Current API requirements

- Use checked provider descriptors with explicit dependency tuples, including
  `inject: []` for factories without dependencies. Token handles infer resolved
  values; raw tokens cannot invent result types.
- Inject native Workers bindings through a typed environment token. Bootstrap
  occurs before provider construction. Drivers and live logs belong to each
  application. Applications reject events from another environment.
- Share endpoint and live argument/result schemas. The runtime validates those
  schemas; the generated HTTP client uses upstream Hono `hc`. Unspecified or
  projected CRUD responses remain `unknown` until parsed by the consumer.
- Authentication providers publish one immutable verified identity. Common
  authorization uses its principal, tenant, and expiry.
- CRUD hooks distinguish persisted rows from shaped output. Compound pagination
  cursors include a unique tie-breaker. D1 callback transactions are unsupported;
  operations requiring them fail before effects.
- Studio's local host, admin API token, and application credentials are separate.
  Live and presence inspection require an explicit `StudioLiveSource`. On
  Cloudflare it addresses known room stubs; it does not enumerate every DO.

See [the type migration guide](packages/vela/TYPE_CONTRACTS.md) and the
[complete starter](apps/api-starter/README.md).

## Verification and artifacts

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --dir packages/vela api:check
pnpm peers check
node scripts/release-pack.mjs
node scripts/release-consumer.mjs
```

Packing converts workspace/catalog ranges to public versions, rejects local
runtime dependency paths, and records a SHA-512 for each archive. The consumer
check installs the tarballs with npm outside the workspace, builds and typechecks
the complete starter, checks client generation, and bundles its Worker.

Artifacts live in `.modernization/release-artifacts/`. Keep this exact directory
once publishing begins: rebuilding a partial release changes archive integrity
and intentionally blocks an ambiguous retry.

## Publication through GitHub OIDC

The root `release.yml` workflow runs on `main` and can also be dispatched manually.
It installs the pinned toolchain and runs the full verification gate. The organization currently disables bot-created pull requests, so prepare
versions with `pnpm version-packages` and merge a normal PR. Merging version
changes publishes the exact
archives that passed the external consumer check. The action creates package
Git tags and GitHub releases. `release-plan.json` contains only changed packages.

Each public npm package trusts GitHub repository `velajs/vela`, workflow
`release.yml`, environment `release`. The GitHub environment permits only `main`.
The job has `id-token: write`; no npm token or setup-node registry auth file is
needed. npm 11.19.0 performs the OIDC exchange. Because npm OIDC authorizes
publication rather than standalone dist-tag edits, CI publishes validated stable
versions directly to `latest`, in dependency order. A failure can leave a partial
set published; it cannot roll back immutable versions.

This repository is public. The workflow requires npm provenance for every upload
with `NPM_CONFIG_PROVENANCE=true`. npm signs the package's provenance using the
GitHub Actions identity and records the source commit and workflow invocation.
Versions published before this was enabled retain their original metadata;
provenance is attached when a new version is published.

For subsequent changes, run `pnpm changeset` and commit the note. At release time,
run `pnpm version-packages`, review the generated changes, and merge them. A main
branch with unversioned changesets is verified but not published.
Versioning updates changelogs, the core skill version, the shared lockfile, and
the release plan. All active packages use the TypeScript 7 catalog; the isolated
TypeDoc compatibility dependency is documented in `docs/tooling.md`.

## Interactive recovery

```sh
npm login
node scripts/release-publish.mjs /absolute/path/to/tested-artifacts
```

The interactive publisher stages the set under `next`, verifies every registry
checksum, then promotes `latest` (npm may require a separate passkey approval for tag
changes). It journals accepted submissions and waits for
npm's asynchronous registry processing before checking integrity. Keep the exact
artifacts and journal after an interruption. A different archive at an existing
version is a hard failure. The pack script refuses to overwrite an existing
artifact manifest; choose a fresh destination for new builds.

GitHub retains release artifacts and the consumer proof for 30 days, including
on failed publication. Do not rebuild a partially published release from changed
source. Use those artifacts for recovery, and verify all versions before tagging.

## Validation on 2026-09-20

- 3,314 tests passed after monorepo integration, including native Workers and D1 coverage.
- Local and staging smoke passed: auth, D1 CRUD, live mutations, Studio models,
  subscriptions, and presence.
- Browser login, generated-client writes, two sessions, and Studio Live verified.
- Clean packed-consumer install/build/types/client generation/Worker bundle passed.
- Staging: <https://vela-api-starter-staging.labo.workers.dev>.

Evidence is in `.modernization/release-*.log`. Staging has a separate D1 database
and generated secrets. The example is a shared test board, not a production
tenant-isolation example. MySQL has not been tested against a real server.
