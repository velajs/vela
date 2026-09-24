# live-todo — realtime todo + presence on `@velajs/vela/live`

A two-runtime demo of Vela live queries using the linked workspace client. The server and browser share argument/result parsers in `src/live-contract.ts`, and `src/app.module.ts` declares the application once as a static `AppModule` that both entries boot unchanged. It imports the core `WebSocketModule.forRoot()` and `LiveModule.forRoot()`: on node the host serves the gateway in process and invalidations deliver locally; on Workers the Cloudflare adapter forwards upgrades to the room's `LiveRoom` Durable Object, routes Worker invalidations there, and keeps the cursor log in its SQLite storage. `TodoStoreFactory` keeps todos in the environment's `TODOS` KV namespace when one is bound, and in process memory on node. The gateway admits every upgrade as an anonymous visitor through `AnonymousDemoAuthenticator`, a demo `UpgradeAuthenticator` class; a real application verifies a session cookie or a short-lived socket ticket there.

From the workspace root, run `pnpm install --frozen-lockfile` and `pnpm build` first. Then run either command below from this example directory:

| Variant | Run | Resume semantics |
|---|---|---|
| Node host (`@hono/node-ws`) | `pnpm start` → http://localhost:8788 | per-process epoch — a restart forks the timeline and reconnects snapshot |
| Cloudflare Worker (Vite + workerd) | `pnpm dev` → http://localhost:8789 | Durable Object SQLite retains cursor history; restored subscriptions are validated and their volatile baselines rebuilt |

`src/server-node.ts` is a **Node-only host**: `pnpm start` compiles it with tsdown
into `dist/node/` and runs it with Node. Workers never load it.

The Cloudflare variant needs no compile step. Vite 8 and
`@cloudflare/vite-plugin` run `src/worker.ts` and its `LiveRoom` Durable Object
in workerd, and serve `public/` as static assets. Oxc emits the legacy
decorators and `design:paramtypes` metadata that `oxc.config.ts` asks for, which
is what lets `TodosController` and `TodoLive` receive their dependencies from
constructor types alone. Both variants serve the page and the esbuild bundle of
`web/main.ts` from `public/`, which `pnpm run bundle:web` writes.

```sh
pnpm test        # the Worker inside workerd: KV store, DO commit stamps, the room upgrade, constructor metadata
pnpm build       # vite build (deployable Worker in dist/) and the Node host
pnpm preview     # serves the Vite build on :8789
```

Open two tabs. Add todos (optimistic, gated on `Vela-Commit-Cursor`), watch presence, and read the **wire panel**, which prints every `$live` frame. The **"simulate network blip"** button closes the raw socket: reconnect uses a resume when the retained history and baseline allow it, otherwise a validated fresh snapshot.

## What this demo deliberately shows

- **Shared query contract**: `@LiveQuery('todos.list', todoListDefinition, { tags: ['todos'] })` and `createLiveClient({ queries: { 'todos.list': todoListDefinition }, ... })` consume the same schemas. Tag invalidations rerun the query, and server/client validate its results.
- **Commit headers**: mutation responses carry `Vela-Commit-Cursor`/`Vela-Commit-Epoch` (stamped explicitly via `stampCommitHeaders`) — the client's optimistic layers drop exactly when a live frame's cursor passes them.
- **Cloudflare data locality** (`TodoStore` seam): the Worker (HTTP mutations) and the Durable Object (live re-runs) are separate app instances. Shared data MUST live in a shared store — KV here, D1/Postgres in real apps. Per-isolate memory would make writes invisible to re-runs.
- **Native bindings**: the Worker and the Durable Object each seed their native environment as the framework `ENV` before construction and resolve it independently; `TodoStoreFactory` injects it with `@Optional() @InjectEnv()`, and live drivers and cursor logs are created per application. `pnpm types` (`wrangler types --include-runtime=false`) regenerates `worker-configuration.d.ts`, which types `TODOS` and `CHAT_ROOM` on `VelaEnv`. The example's KV read-modify-write store illustrates sharing and does not provide concurrent-write atomicity.

## Cloudflare footguns encoded here

1. The DO class must be SQLite-backed: `migrations[].new_sqlite_classes: ["LiveRoom"]`.
2. Don't stamp commit headers via `ambientContainer`/`contextStorage()` on Workers — awaiting a Durable Object RPC inside hono's ALS middleware hangs the response under workerd. Stamp explicitly (the `@velajs/crud` bridge does this for you).
