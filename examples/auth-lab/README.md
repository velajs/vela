# auth-lab

End-to-end smoke for `@velajs/better-auth` — real `betterAuth({...})` instance with the in-memory adapter, a protected route, a public route, and a service that injects the auth instance.

```bash
pnpm install
pnpm smoke              # runs in-process against Hono.request()
pnpm dev                # starts a Node server on :8787
pnpm deploy             # wrangler deploy
```

What it demonstrates:

- **Protected route** (`GET /me`) — `@CurrentUser()` reads the better-auth user out of REQUEST_CONTEXT, AuthGuard runs as `APP_GUARD` (deny-by-default).
- **Public route** (`GET /stats`) — `@Public(true)` bypasses the global guard.
- **Service-level access** (`StatsService`) — `@Inject(BETTER_AUTH)` gives any vela injectable the full `auth.api.*` surface.
- **Auto-mounted handlers** — sign-up / sign-in / sign-out at `/api/auth/*` without writing controllers.

What you'd change for production:

- Swap `memoryAdapter(memory)` for `drizzleAdapter(drizzle(env.DB), { provider: 'sqlite' })` (Cloudflare D1) or any other better-auth adapter.
- Move the `secret` to an env var.
- Add `socialProviders`, `plugins: [magicLink(...), apiKey(), twoFactor()]` etc. to `betterAuth({...})`.
