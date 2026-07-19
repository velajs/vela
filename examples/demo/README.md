# @velajs/studio-demo

A runnable example that wires the **whole Vela Studio product** together on the
Node adapter (no Cloudflare), plus a reproducible end-to-end walkthrough that
drives every admin operation to prove the pieces integrate.

This package is **private** (not published). It is the conformance gate for the
Studio monorepo.

## What it wires

| Piece | Module | Panel it lights |
| --- | --- | --- |
| Admin surface + gates | `StudioModule.forRoot({ path, token, rootModule, editable })` | the reserved `/_vela/admin` API |
| Data browser | `StudioCrudModule` over 3 `@Crud` models (`author` → `book` (soft-delete) + `tag`) | `data.*` |
| Portable time travel | `StudioTimeTravelModule` (in-memory snapshot store) | `timeTravel.*` (granularity `snapshot`) |
| Feature flags | `StudioFlagsModule` + `FeatureFlagsModule` | `flags.*` |
| Schedule | `StudioScheduleModule` + `ScheduleModule` (a `@Cron` job) | `schedule.*` |
| Queues | `StudioQueueModule` + `QueueModule` (a `@Processor`) | `queue.*` |
| Route attribution | `studioRuntimeAdapter` (passed to `VelaFactory.create`) | real `Controller#handler` in `app.routes` |

**Auth is intentionally not wired** (it needs better-auth + a DB): the auth panel
reports `FEATURE_UNCONFIGURED` and `features.auth` stays `false` — an acceptable
demo state. **Live/presence** are likewise not wired.

The models are authored with the **real crud surface** — `defineModels` over real
`zod` schemas + the `@Crud` decorator. crud is BYO-DB and ships no memory adapter
(there is no `@velajs/crud-memory` package), so the demo supplies a small
in-memory `CrudAdapter` in `src/memory-adapter.ts`, exactly as the server
package's own tests do.

## Run the app

```bash
pnpm --filter @velajs/studio-demo build
VELA_STUDIO_TOKEN=my-secret PORT=8787 node examples/demo/dist/main.js
```

Then open Studio against it (the admin surface is at `<url>/_vela/admin`):

```bash
vela studio --url http://localhost:8787
```

`vela.config.ts` exports `createApp()` for the CLI's config-boot path as well.

## Run the walkthrough (the conformance gate)

The walkthrough is the durable test. It boots the app + the loopback host
**in-process**, drives every op via `app.request`, asserts the time-travel
snapshot → restore → undo round-trip and the 428 confirm flows, and confirms the
host serves the SPA shell + standalone bundle, injects the master bearer
server-side, and 403s a gate rejection.

```bash
# As the CI conformance gate (vitest):
pnpm --filter @velajs/studio-demo test

# As a human-readable pass table (after build):
node examples/demo/scripts/walkthrough.mjs
```

Both share one runner (`src/walkthrough.ts`).
