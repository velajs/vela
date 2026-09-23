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

Open `http://localhost:8790`, create a local account, and open a second tab.
Create, complete, or delete a task in either tab to see the live query update.
The HTTP API and WebSocket upgrade both verify the same session cookie.

In another terminal in this directory:

```sh
VELA_STUDIO_TOKEN=local-studio-only-change-before-deployment-123456 pnpm studio
pnpm smoke
pnpm client:check
```

Studio opens on port 8791. Its token is separate from the application's session
cookie and is never bundled in the browser. The smoke script creates a temporary
account and task, checks authentication and live CRUD updates plus Studio's
models/subscriptions/presence, then removes its test data.

`src/contracts.ts` is the shared runtime contract for live arguments and rows.
`web/api.generated.ts` is generated from the module's OpenAPI document and has
no runtime server imports. CRUD request bodies and path parameters are typed.
CRUD responses remain `unknown` because the general CRUD surface allows custom
envelopes and projections; parse those responses before consuming them. The
browser renders rows validated by the live contract.

`{ create: createAppModule }` builds a graph from each native Workers environment.
There is no process-global environment or secret: the same environment is the
framework `ENV`, which `TodoQueries` injects with `@InjectEnv()` and Studio
reads its `VELA_STUDIO_TOKEN` from. `pnpm types` regenerates
`worker-configuration.d.ts` from `wrangler.jsonc` and the secret names in
`.dev.vars.example`, so `VelaEnv` carries the typed bindings. `src/env.ts` only
narrows the Durable Object binding to its source class, because Wrangler reads
classes from the built entry. Studio's live source explicitly
addresses the `default` room with `durableObjectRoomName`; Cloudflare has no
global room enumeration API. Inspection excludes query arguments, results,
authentication claims, and presence metadata. `connectedAt` describes when the
current engine attached the connection, including after hibernation.

For staging, create a separate D1 database, set its ID in a separate Wrangler
configuration, apply the migration with `--remote`, and deploy with a real
`APP_ORIGIN` and independently generated `BETTER_AUTH_SECRET` and
`VELA_STUDIO_TOKEN` secrets. Never deploy the local example secrets. Run:

```sh
APP_ORIGIN=https://your-worker.example VELA_STUDIO_TOKEN=your-studio-token pnpm smoke
```

The browser and Worker have separate TypeScript configurations to prevent DOM
and Workers ambient APIs from being mixed. D1 callback transactions remain
unsupported; each single-row write here uses D1's native statement semantics.
