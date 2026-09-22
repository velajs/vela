# @velajs/cli

## 1.25.0

### Minor Changes

- 4a6f5df: Add schema-bound multipart and URL-encoded endpoint bodies with native files,
  repeated fields, explicit bounded parsing, and matching OpenAPI contracts. Generate
  accurate form request types and encoding metadata, with an opt-in HTTP fetch adapter
  that preserves caller transports and request options. Existing JSON endpoints and
  Hono client exports remain compatible.

### Patch Changes

- Updated dependencies [efdf854]
- Updated dependencies [4a6f5df]
  - @velajs/vela@1.26.0

## 1.24.0

### Minor Changes

- 2c1cac6: Add read-only `vela doctor` config provenance and opt-in application snapshots.
  Validate imported configs and Studio ports and preserve inferred config subtypes.
  Generate a Node-side config
  that imports the starter's SWC output, and explain the decorator/compiler boundary.
- 50358a1: Add read-only `vela deploy check` for explicit Wrangler environments and saved entrypoint snapshots. Validate configuration, cron and queue alignment, and WebSocket Durable Object bindings; report redacted target information and git/input provenance without constructing applications, running custom builds or uploading code.
- 4fde903: Discover seeders per owning module registration and await async resolution inside
  managed invocation scopes. Preserve sequential ordering and stop/continue behavior
  while settling deferred work before disposal. Add optional module ownership to
  seeder inventories and expose it through `vela db seed --list --json` without
  executing seeders.

### Patch Changes

- 6d33ac9: Dispose applications after seeder registry or command failures, preserving the
  primary result when cleanup fails. Share command lifetime handling across
  introspection, client generation and MCP, including cleanup of older 1.x apps
  whose shutdown hooks throw.
- Updated dependencies [c6a43a6]
- Updated dependencies [bbe62d4]
- Updated dependencies [a6ef933]
- Updated dependencies [dae3654]
- Updated dependencies [77cca9e]
- Updated dependencies [b9f75f5]
- Updated dependencies [df47ea8]
- Updated dependencies [af019bf]
- Updated dependencies [6df1059]
- Updated dependencies [bdd90a1]
- Updated dependencies [8a3923f]
- Updated dependencies [c7d108b]
- Updated dependencies [1c7f635]
- Updated dependencies [636ffbc]
- Updated dependencies [54f8864]
- Updated dependencies [f49db45]
- Updated dependencies [4fde903]
- Updated dependencies [6a1b5b3]
- Updated dependencies [a95951a]
- Updated dependencies [9e82187]
- Updated dependencies [c5a3cb0]
- Updated dependencies [363fb71]
- Updated dependencies [de4e57e]
- Updated dependencies [0765aaa]
- Updated dependencies [6b7cf23]
- Updated dependencies [5205e58]
- Updated dependencies [ae45689]
  - @velajs/vela@1.25.0

## 1.23.0

### Minor Changes

- 23c7808: Add `vela new <name>` to create a minimal Cloudflare Workers application with a module, controller, and constructor-injected service. Include published npm dependencies, TypeScript and SWC decorator configuration, Wrangler source rebuilds, pnpm scripts, and a short runnable README. Reject invalid names and nonempty destinations without overwriting files. Report the actual package version from `vela --version`.

## 1.22.1

### Patch Changes

- Publish from the public velajs/vela repository through GitHub Actions OIDC with required signed npm provenance. Attestations identify the source commit and release workflow for each package.
- Updated dependencies
  - @velajs/vela@1.22.1

## 1.22.0

### Minor Changes

- Continue the coordinated framework release on the 1.x line with the current checked provider, endpoint, identity, CRUD, live, and Studio APIs. Breaking API changes are accepted during this development phase; maintained applications use the current contracts.
- Publish from the pnpm packages workspace with TypeScript 7 and GitHub OIDC. Obsolete standalone examples have been removed; runnable applications live in apps/.
- Updated workspace dependencies
  - @velajs/studio-host@1.22.0
  - @velajs/vela@1.22.0

## 2.0.1

### Patch Changes

- Publish from the unified packages workspace with corrected repository paths, shared native tooling, TypeScript 7 checks, and npm OIDC releases. Runnable examples now live in apps/.
- Updated dependencies
  - @velajs/vela@2.0.1

## 2.0.0

Schema-driven Hono client generation and the local Vela Studio host command. Generated contracts preserve unknown types where a response schema is absent.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.0.0

### Major Changes

- faef8b1: Require the Vela 1.21 runtime so generated and inspected applications use the coordinated security-boundary release.

## 0.3.2

### Patch Changes

- 1e1ec9c: Modernize the package build, validation, and release toolchain.
