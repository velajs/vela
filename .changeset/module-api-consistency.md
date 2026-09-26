---
'@velajs/vela': minor
'@velajs/cloudflare': minor
'@velajs/cli': minor
'@velajs/graphql': minor
'@velajs/storage': minor
'@velajs/mail': minor
'@velajs/crypto': minor
'@velajs/rpc': minor
'@velajs/better-auth': minor
'@velajs/authz': minor
'@velajs/authz-cedar': minor
'@velajs/tenant': minor
'@velajs/cloudflare-access': minor
'@velajs/feature-flags': minor
'@velajs/studio': minor
'@velajs/testing': minor
---

Align module APIs with instance ownership: shared facilities use forRoot, local and named services use register, and Queue, I18n and Seeder contribute declarations through forFeature. Remove replaced APIs. Local registrations receive independent identities; reused definitions share within an application, and explicit keys retain conflict checks.

Require applications to attach exported guards and interceptors explicitly. Remove automatic installation and guard options while preserving policy ownership, request scope, phase ordering, testing overrides and integration-route exemptions. Keep translation contributions and mutable runtime configuration isolated per application, and return runtime-only settings from async factories. Storage separates structural httpController mounting from runtime http options.

Add schema-first GraphQL resolver and parameter decorators with exact provider ownership, endpoint selection and duplicate binding validation. Add the optional Cloudflare workflow-definitions entrypoint to host portable workflows and compiled agents with validated input, per-run dependency resolution, explicit dispatch authority and native replay/error semantics.

Update CLI output, runnable examples, packed consumers and migration documentation together. See docs/module-api-migration.md for the new signatures and required application changes. This is a coordinated breaking change on the 1.x line; no compatibility aliases are retained.
