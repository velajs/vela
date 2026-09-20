# auth-lab

End-to-end smoke for `@velajs/better-auth` — real `betterAuth({...})` instance with the in-memory adapter, a protected route, a public route, and a service that injects the auth instance.

```bash
pnpm install
pnpm smoke              # in-process against Hono.request() (13 checks)
pnpm wrangler:smoke     # real wrangler dev + curl-equivalent (8 checks)
pnpm dev                # Node server on :8787
pnpm deploy             # wrangler deploy
```

## Wrangler gotcha — direct adapter import

This example imports `memoryAdapter` directly from `@better-auth/memory-adapter`,
not from `better-auth/adapters/memory`. The latter is a one-line
`export * from '@better-auth/memory-adapter'` re-export, which esbuild (used
by Wrangler) wraps in an async init shim — top-level callsites observe
`memoryAdapter === undefined` at module evaluation, and you get the runtime
error:

```
TypeError: memoryAdapter is not a function
```

Direct imports from the underlying package resolve to a real ESM binding at
module-load time and sidestep the hazard. This pattern applies to any
`export *` re-export chain consumed under workerd / esbuild bundling.

What it demonstrates:

- **Protected route** (`GET /me`) — `@CurrentUser()` reads the better-auth user out of REQUEST_CONTEXT, AuthGuard runs as `APP_GUARD` (deny-by-default).
- **Public route** (`GET /stats`) — `@Public(true)` bypasses the global guard.
- **Service-level access** (`StatsService`) — `@Inject(BETTER_AUTH)` gives any vela injectable the full `auth.api.*` surface.
- **Auto-mounted handlers** — sign-up / sign-in / sign-out at `/api/auth/*` without writing controllers.

What you'd change for production:

- Swap `memoryAdapter(memory)` for `drizzleAdapter(drizzle(env.DB), { provider: 'sqlite' })` (Cloudflare D1) or any other better-auth adapter.
- Move the `secret` to an env var.
- Add `socialProviders`, `plugins: [magicLink(...), apiKey(), twoFactor()]` etc. to `betterAuth({...})`.
