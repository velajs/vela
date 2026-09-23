# auth-lab-d1

Cloudflare D1-backed end-to-end smoke for `@velajs/better-auth`. Demonstrates
**Pattern B** wiring: `BetterAuthModule.forRootAsync` injects the framework
`ENV` (the native Workers environment), hands `env.DB` to `drizzle-orm/d1`, and
passes the resulting drizzle instance into `better-auth`'s `drizzleAdapter`.

```bash
pnpm install
pnpm wrangler:smoke        # auto-reset DB, apply migration, run wrangler dev, drive HTTP
pnpm dev                   # interactive: wrangler dev on :8789
pnpm db:reset              # nuke local D1 + reapply migrations/0000_initial.sql
pnpm types                 # regenerate worker-configuration.d.ts from wrangler.toml
```

`wrangler:smoke` runs 6 checks: healthz, 401-without-session, sign-up,
cookie capture, /me with cookie, and verifies the user row round-tripped
through D1.

## Wiring

```ts
import { schema } from './schema';
import { ENV } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      inject: [ENV],
      // useFactory returns the betterAuth() instance directly.
      useFactory: (env) =>
        betterAuth({
          // Pass `schema` so the adapter maps better-auth's models to typed
          // drizzle tables — required on D1 (Date columns use `{ mode:
          // 'timestamp' }`; a bare adapter throws D1_TYPE_ERROR on a Date).
          database: drizzleAdapter(drizzle(env.DB, { schema }), {
            provider: 'sqlite',
            schema,
          }),
          // ...
        }),
      isGlobal: true,
    }),
  ],
})
class AppModule {}
```

`createCloudflareWorker(AppModule)` seeds the native platform environment as
`ENV` before DI factories run. `env.DB` is typed as `D1Database` by the
`worker-configuration.d.ts` that `pnpm types` (`wrangler types
--include-runtime=false`) generates from `wrangler.toml`. Each environment owns
its own app and auth instance. No binding wrapper or first-request capture is
required.

## Schema + migrations

`migrations/0000_initial.sql` is a hand-written SQLite schema matching
better-auth ^1.6.0's standard tables (user, session, account, verification)
plus the foreign keys and indexes better-auth uses. For plugin schemas
(2FA, organization, admin, magic link, etc.), regenerate with:

```bash
pnpm dlx better-auth generate
```

…and drop the output into `migrations/`.

`pnpm db:reset` wipes the local D1 sqlite file under `.wrangler/state/` and
re-applies the migration via `wrangler d1 execute --local`.

## Deploying to a real D1 binding

1. `wrangler d1 create velajs-better-auth-d1` — creates the remote database.
2. Copy the returned `database_id` UUID into `wrangler.toml`.
3. `wrangler d1 execute velajs-better-auth-d1 --remote --file=migrations/0000_initial.sql`.
4. Replace the hard-coded `secret` and `baseURL` in `src/app.ts` with Worker
   secrets and variables read from the factory's `env` (the injected `ENV`),
   validating each value, and rerun `pnpm types`.
5. `pnpm deploy`.

## Direct imports (workerd hazard)

Like `auth-lab/src/app.ts`, this example imports the better-auth adapter
directly from `@better-auth/drizzle-adapter` instead of via the
`better-auth/adapters/drizzle` re-export — esbuild (Wrangler's bundler)
wraps `export *` chains in an async init shim that leaves the named import
undefined at module-evaluation time. See `auth-lab/README.md` for the full
explanation.
