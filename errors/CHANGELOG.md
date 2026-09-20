# Changelog

## 2.0.0

Coordinated Vela 2.0 toolchain and package release. The standalone error behavior is unchanged.

Requires the coordinated Vela 2.0 package set. See the workspace migration guide.

## 1.1.0

### Minor Changes

- ac4e9f8: Add the `@velajs/errors/fingerprint` subpath: a zero-dependency, cross-runtime error-grouping hash. `fingerprintError({ functionPath, message, code? })` returns a stable 16-hex-char digest over `functionPath` plus a normalized message bucket — `code` is metadata and never hashed, so redacted wire errors and raw server-side errors group identically. Ships `bucketMessage` (strips URLs, UUIDs, IPs, ids, paths, timestamps; ReDoS-clamped), `FINGERPRINT_VERSION` for persisted-fingerprint migrations, and a portable synchronous `sha256Hex` (content-addressing only, never a security primitive). Grouping approach inspired by @superlog/fingerprint (Apache-2.0), independently implemented.

## 1.0.1

### Patch Changes

- 49f72ad: Modernize the package build, validation, and release toolchain.

All notable changes to `@velajs/errors` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0

Initial release — the unified, zero-dependency error layer for Vela.

### Added

- **`VelaError`** — one framework error class carrying `code`, `status`, `hint`, `docsUrl`, and `data` as own-enumerable properties, so an error rides any wire codec / `structuredClone` / Durable-Object RPC boundary with no special serialization path. Branded with an own-enumerable `type: "VelaError"` discriminator.
- **Composable catalogs** — `defineErrorCatalog` (typed, keys derive the code union), `composeCatalogs` (merges catalogs and throws on a duplicate code at compose time), the built-in `CORE_CATALOG` (the HTTP status family), and `STATUS_TO_CODE`. Catalog lookups use `Object.hasOwn`, so prototype keys (`toString`, `constructor`, …) are never matched.
- **`isVelaError`** — a structural, realm-safe, **branded** type guard: `instanceof Error` plus a string `code`, a numeric `status`, and the `VelaError` brand. Survives serialization and the DO↔worker boundary where `instanceof` is unreliable, and a foreign error that merely carries `code`+`status` cannot pass.
- **`toErrorBody`** — the single wire-redaction seam. Unbranded and internal-coded errors are redacted to a generic message; branded, non-internal errors echo their `message`/`hint`/`details`. Returns a `redacted` flag so callers log the raw error server-side. Pluggable `redactedMessage` and `encodeData` hooks.
- **`invariant` / `unreachable`** — assertion helpers that throw an internal-coded `VelaError` (rich in server logs, redacted on the wire).

### Notes

- Zero runtime dependencies; ESM; `sideEffects: false`; edge-runtime safe (no `node:*`, `Buffer`, or `process`).
