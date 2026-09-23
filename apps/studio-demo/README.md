# @velajs/studio-demo

A runnable example that wires the **whole Vela Studio product** together on the
Node adapter (no Cloudflare), plus a reproducible end-to-end walkthrough that
drives every admin operation to prove the pieces integrate. It is a **Node host**:
tsdown compiles it and Node runs it; it never runs in workerd.

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

The models use `defineModels` over Zod schemas and the `@Crud` decorator. The demo
supplies a small in-memory adapter through `bindAdapter` in `src/memory-adapter.ts`.
It serializes request scopes and rolls back failed transactions across tables, so
Studio can expose bulk writes with a real rollback guarantee. Time-travel modules
explicitly import the configured Studio and model-source modules.

Every class is declared once, at module scope. Each `createApp()` call seeds its
own in-memory store and registers its adapters as the named crud database `demo`
through `CrudModule.forRoot({ databases })`, so Studio names the models
`demo::author`, `demo::book` and `demo::tag`, and building another application
declares no new classes.

## Run the app

```bash
pnpm --filter @velajs/studio-demo build
VELA_STUDIO_TOKEN=my-secret PORT=8787 node apps/studio-demo/dist/main.js
```

Then open Studio against it (the admin surface is at `<url>/_vela/admin`):

```bash
vela studio --url http://localhost:8787
```

`vela.config.ts` is the CLI's config-boot entry: `pnpm exec vela route list` or
`pnpm exec vela doctor --app` in this directory loads it, and the decorated
sources it imports, through Vite and boots the demo in-process.
Both Node entries pass `process.env` as the application's `ENV`, and Studio
reads `VELA_STUDIO_TOKEN` from it; without one, the demo falls back to its
non-production `DEV_TOKEN`.

## Run the walkthrough (the conformance gate)

The walkthrough is the durable test. It boots the app + the loopback host
**in-process**, drives every op via `app.request`, asserts the time-travel
snapshot → restore → undo round-trip and the 428 confirm flows, and confirms the
host serves the SPA shell and standalone bundle, authenticates its browser session,
injects the master bearer server-side, and rejects an invalid transport request.
Every admin response passes through the shared operation-specific protocol parser.
The host package separately verifies API Explorer execution against actual
Miniflare/Workerd HTTP with native bindings and execution context; the Node demo
does not substitute for that Worker integration test.

```bash
# As the CI conformance gate (vitest):
pnpm --filter @velajs/studio-demo test

# As a human-readable pass table (after build):
node apps/studio-demo/scripts/walkthrough.mjs
```

Both share one runner (`src/walkthrough.ts`).
