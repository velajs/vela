---
"@velajs/studio": minor
---

**Behavior change:** Studio reads its `VELA_STUDIO_*` variables and secrets from the application's `ENV`, when a runtime seeded one, instead of `CONFIG_ENV`. On Workers, a `VELA_STUDIO_TOKEN` secret (and the `VELA_STUDIO_*_EDITABLE` flags) now takes effect automatically, because `@velajs/cloudflare` seeds the Worker environment as ENV; before, it was never read there. Module options still override environment values, non-string values are ignored, and Studio stays closed when no token is configured.

**Behavior change:** the `studioConfig` namespace export is removed, with no alias. Use `readStudioEnv(env)` to parse the `VELA_STUDIO_*` values of an environment into a `StudioEnvConfig`, and `resolveStudioConfig(envConfig, options)` to merge them under module options.
