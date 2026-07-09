# live-todo — realtime todo + presence on `@velajs/vela/live`

A two-runtime demo of Vela live queries, driven by the published `@velajs/client`. One shared app module (`src/app.module.ts`); two transports:

| Variant | Run | Resume semantics |
|---|---|---|
| node (`@hono/node-ws`) | `pnpm start` → http://localhost:8788 | per-process epoch — a restart forks the timeline and reconnects snapshot |
| Cloudflare (`wrangler dev`) | `pnpm run start:cf` → http://localhost:8789 | REAL — the cursor log lives in the Durable Object's SQLite and survives hibernation/eviction/restarts |

Open two tabs. Add todos (optimistic, gated on `Vela-Commit-Cursor`), watch presence, and read the **wire panel** — it prints every `$live` frame. The **"simulate network blip"** button closes the raw socket: on reconnect an untouched `todos.list` gets a tiny `resume` (Cloudflare variant), while the roster (touched by the other tab's heartbeats) re-snapshots.

## What this demo deliberately shows

- **Tags, not magic**: `@LiveQuery('todos.list', { tags: ['todos'] })` re-runs when a mutation calls `LiveInvalidation.invalidate({ tags: ['todos'] })`.
- **Commit headers**: mutation responses carry `Vela-Commit-Cursor`/`Vela-Commit-Epoch` (stamped explicitly via `stampCommitHeaders`) — the client's optimistic layers drop exactly when a live frame's cursor passes them.
- **Cloudflare data locality** (`TodoStore` seam): the Worker (HTTP mutations) and the Durable Object (live re-runs) are separate app instances. Shared data MUST live in a shared store — KV here, D1/Postgres in real apps. Per-isolate memory would make writes invisible to re-runs.

## Cloudflare footguns encoded here

1. The DO class must be SQLite-backed: `migrations[].new_sqlite_classes: ["LiveRoom"]`.
2. Don't stamp commit headers via `ambientContainer`/`contextStorage()` on Workers — awaiting a Durable Object RPC inside hono's ALS middleware hangs the response under workerd. Stamp explicitly (the `@velajs/crud` bridge does this for you).
