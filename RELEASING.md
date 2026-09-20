# Vela 2.0 release

The user's clarified product target and independent acceptance criteria are in
[DESIGN.md](DESIGN.md). The archives below are a verified implementation snapshot;
their package count and passing tests do not settle the public product structure.

This release coordinates the 21 public API workspace packages at **2.0.0**.
`release-plan.json` is the package/version manifest. Deferred AI, agent, mail,
workflow, event-source, and site repositories are not part of this release.

## Migration

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

See [the type migration guide](vela/TYPE_CONTRACTS.md) and the
[complete starter](cloudflare/examples/api-starter/README.md).

## Verification and artifacts

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --dir vela api:check
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

## Publication

```sh
npm login
node scripts/release-publish.mjs
```

The publish script verifies the tested artifact manifest and each archive, then
publishes in dependency order under `next`. Only after verifying all registry
integrities does it promote the set to `latest`. It resumes a partial run only
when existing versions match the recorded artifacts.

All releases originate in `velajs/vela`. CI and Changesets configuration live at
the repository root. Package manifests point to their monorepo directories.
Pushing commits does not publish packages. The manual Prepare release workflow
builds and validates artifacts for download; publication uses the explicit command
above with an authenticated npm account.

For subsequent changes, run `pnpm changeset`, then `pnpm version-packages`.
Versioning updates the affected package changelogs, the core skill version, and
a release plan containing only changed public packages. Commit the generated
changes and root lockfile, run `pnpm release:check`, then publish those exact archives.

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
