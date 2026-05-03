# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-05-03

### Added
- `CrudEndpointName` widened to mirror hono-crud's full surface: `search`, `aggregate`, `restore`, `batchCreate`, `batchUpdate`, `batchDelete`, `batchRestore`, `batchUpsert`, `export`, `import`, `upsert`, `clone`. `ALL_CRUD_ENDPOINTS` enumerates the 17-name surface; `EndpointOverride<M>` exposes a typed slot per name forwarded to hono-crud's `EndpointsConfig<M>`.
- `defineCrudResource(config)` ergonomic helper — bundles `CrudModule.forResource` + programmatic `@Override` application for plugin authors who want to skip the synthetic-controller pattern. Returns a `DynamicModule` that registers identically to `CrudModule.forResource(...)`. The existing `@Crud` decorator on user-written classes remains the canonical form.
- `drizzle-orm` and `drizzle-zod` added as devDependencies — required to import `hono-crud@^0.7.0`'s main bundle so the test suite genuinely exercises the bridge.

### Changed
- `validateEndpointNames` now accepts the widened name set; new tests at `src/__tests__/endpoint-widening.test.ts` cover each new verb end-to-end via `MemoryAdapters`.
- `crud-validation.test.ts` swapped its unknown-name sentinel from `'search'` (now valid) to `'NOT_A_VERB'`.

### Compatibility
- Peer-dep on `hono-crud` raised to `>=0.7.0` (covers the wider `EndpointsConfig` + `defineEndpoints` switch and the post-merge `Model.resolveSchema`/`HookContext`/`requireApproval`/`requirePolicy` surface used by 0.5.0 + 0.6.0 verifications later).
