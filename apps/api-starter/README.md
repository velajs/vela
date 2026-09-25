# Complete Workers API starter

A shared task board with Better Auth email/password sessions, native D1,
schema-backed CRUD, generated Hono client calls, Durable Object live queries,
presence, and authenticated Vela Studio inspection. All signed-in users share
the same board; this example is not a tenant-isolated application.

From the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter vela-api-starter... build
cd apps/api-starter
cp .dev.vars.example .dev.vars
pnpm db:migrate
pnpm dev
```

Vite 8 and `@cloudflare/vite-plugin` serve the Worker from `src/worker.ts` in
workerd; there is no separate compile step. Oxc emits the legacy decorators and
`design:paramtypes` metadata that `oxc.config.ts` asks for, shared by
`vite.config.ts` and `vitest.config.ts`. `pnpm dev` also bundles the browser
client into `public/`, which the Worker serves as static assets.

Open `http://localhost:8790`, create a local account, and open a second tab.
Create, complete, or delete a task in either tab to see the live query update.
The HTTP API and WebSocket upgrade both verify the same session cookie: the
gateway names `authenticator: BetterAuthUpgradeAuthenticator`, and the
`BETTER_AUTH_UPGRADE_TENANT` resolver in `AppModule` admits the shared board's
`default` room only. `allowedOrigins: (env) => [env.APP_ORIGIN]` reads the
browser origin from each environment.

In another terminal in this directory:

```sh
VELA_STUDIO_TOKEN=local-studio-only-change-before-deployment-123456 pnpm studio
pnpm smoke
pnpm client:check
pnpm test
```

Studio opens on port 8791. Its token is separate from the application's session
cookie and is never bundled in the browser. The smoke script creates a temporary
account and task, checks authentication and live CRUD updates plus Studio's
models/subscriptions/presence, then removes its test data. It runs the same
way against `pnpm preview`, which serves the `pnpm build` output on port 8790.
`pnpm test` drives the Worker inside workerd with a migrated test D1 database:
public and protected routes, sign-up, the LiveRoom Durable Object upgrade and
its refusals, two environments building separate applications from the one
`AppModule`, and constructor injection that relies only on the emitted metadata.

`src/contracts.ts` is the shared runtime contract for live arguments and rows,
the `/me` response schema, and the `/healthz` route contract (`defineRoute` from
the browser-safe `@velajs/vela/contract` entry). `MeController` declares its
response with route options (`@Get({ response: meSchema })`), which strips the
session user to its public fields; `HealthController` serves the shared
contract with `@Get(health)`. Both styles validate the handler's result and
document it for the generated client.
`web/api.generated.ts` is generated from the module's OpenAPI document and has
no runtime server imports. `pnpm client:generate` and `pnpm client:check` run
`vela client generate` (through the workspace CLI entry, since the workspace
links `@velajs/cli` before building it). `vela.config.ts` imports `AppModule`,
which the CLI loads through Vite's module runner with the same Oxc options, so
it needs no build. The CLI also builds the application once to check the
document against its routes; the config gives it the local bindings
Wrangler's `getPlatformProxy()` provides and closes them afterwards. CRUD
request bodies and path parameters are typed. CRUD responses remain `unknown`
because the general CRUD surface allows custom envelopes and projections; parse
those responses before consuming them. The browser renders rows validated by
the live contract.

`AppModule` is declared once at module scope, and `src/worker.ts` defines the
app once with `defineCloudflareApp(AppModule)`: it exports `app.worker` and the
`LiveRoom` class built by `VelaWebSocketDurableObject(app)`, which share the
root module and its options. Bindings reach
the graph through dependency injection only: the `forRootAsync({ inject: [ENV] })`
factories of Better Auth and CRUD run for each native environment, so every
environment builds its own auth instance and adapter.
`WebSocketModule.forRoot()` and `LiveModule.forRoot()` need no options: the
Cloudflare adapter forwards gateway upgrades to the `LIVE_ROOM` Durable Object
that `TodoGateway` names and routes live invalidations there, reading the
binding from each environment. `OpenApiModule.forRoot({ path: '/openapi.json',
info })` serves the application's OpenAPI document, which leaves its own route
out. There is no process-global environment or secret: the same
environment is the framework `ENV`, which `TodoQueries` injects with
`@InjectEnv()` and Studio reads its `VELA_STUDIO_TOKEN` from. Studio documents
the application's `ROOT_MODULE`. `pnpm types` regenerates
`worker-configuration.d.ts` from `wrangler.jsonc` and the secret names in
`.dev.vars.example`, so `VelaEnv` carries the typed bindings. Wrangler reads
`main` (`src/worker.ts`), so `LIVE_ROOM` is typed with the `LiveRoom` class and
the types never depend on a build. `src/contracts.ts` declares the
`todos.list` live query once with `defineLiveQuery({ name, args, result })`:
`TodoQueries` serves it with `@LiveQuery(todoList, { tags: [crudLiveTag('todos')] })`
and returns its rows unparsed, since the engine validates each result, and the
browser passes the same `queries` list to `createLiveClient`.
`livePanel({ rooms: ['default'] })` inspects the shared board's
room in its Durable Object, reached through the gateway's `LIVE_ROOM` binding;
Cloudflare has no global room enumeration API, so Studio names the room. Inspection excludes query arguments, results,
authentication claims, and presence metadata. `connectedAt` describes when the
current engine attached the connection, including after hibernation.

For staging, create a separate D1 database, declare it with a real `APP_ORIGIN`
in a `staging` Wrangler environment, apply the migration with `--remote`, and set
independently generated `BETTER_AUTH_SECRET` and `VELA_STUDIO_TOKEN` secrets.
Never deploy the local example secrets. Build and deploy that target with
`CLOUDFLARE_ENV=staging pnpm build && pnpm exec wrangler deploy`; do not pass
`--config` to `wrangler deploy`, which would bundle the source without decorator
metadata (see [deployment](../../docs/deployment.md#build-with-vite)). Run:

```sh
APP_ORIGIN=https://your-worker.example VELA_STUDIO_TOKEN=your-studio-token pnpm smoke
```

The browser, Worker and workerd tests have separate TypeScript configurations
(`tsconfig.web.json`, `tsconfig.json`, `tsconfig.test.json`) to prevent DOM,
Workers and test-only bindings from being mixed. D1 callback transactions remain
unsupported; each single-row write here uses D1's native statement semantics.
