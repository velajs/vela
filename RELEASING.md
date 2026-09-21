# Vela releases

The active release line is 1.x. Public workspace packages are published through
GitHub Actions OIDC with signed provenance from this public source repository.
`release-plan.json` records the packages and versions in each release.
Breaking changes are accepted during this development phase; applications should
use the current APIs described below. Release titles use plain versions, such as
`Vela 1.22.1`.

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

See [the core type guide](docs/types.md) and the
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
When the release includes the CLI, it also runs the installed packed `vela new`
outside the workspace, installs the generated project's published dependencies
with pnpm, checks types and builds, and verifies HTTP, constructor injection,
and source rebuilds under local Wrangler. CLI argument and destination failure
cases run against that same installed archive.

When the release includes `@velajs/event-source`, a separate clean consumer installs
its archive and checks the root runtime/type exports and inventory checkpoint
example. It records its own integrity proof in `consumer.json`; the API starter
does not depend on this optional package. New public subpaths require extending
that check.

When `@velajs/ai` is in the release, the consumer gate additionally installs its
exact archive in an independent fixture, without Vela or a provider package. It
checks both the base and `/rag` exports, TypeScript/AI SDK/Zod compatibility,
tenant isolation, tool validation, and re-sync. Run it independently with
`node scripts/ai-consumer.mjs /absolute/path/to/velajs-ai-<version>.tgz`.

When the release includes `@velajs/workflow`, the consumer gate also installs its
archive in an independent project, checks the root and `/harness` declarations
with Zod 4, and runs the approval/retry/replay example. This coverage does not
depend on the API starter importing workflow. For a prepared archive manifest,
run it directly with `node scripts/workflow-consumer.mjs /absolute/artifact/path`.

When mail is present, a separate consumer installs its archive without Vela and
checks the transport/catcher/testing subpaths, then installs Vela to check the
main entry, injection types, queue delivery, and inbound scope disposal. This
coverage runs even though mail is not an API starter dependency. It can also be
run directly with `node scripts/mail-consumer.mjs /absolute/path/to/artifacts`.

When agent is present, its dedicated consumer checks root, `/mcp`, and `/testing`
with the migrated AI, workflow, and mail packages. The release agent archive is
used unchanged; absent companion archives are packed from the built workspace
for testing only and recorded by integrity in the proof. This leaves the
publication plan unchanged. It checks strict declarations, RAG/mail integration,
persisted approvals, duplicate delivery, and imports without optional runtime
peers. Run `node scripts/agent-consumer.mjs /absolute/path/to/artifacts` directly.

Artifacts live in `.artifacts/release/`. Keep this exact directory
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
