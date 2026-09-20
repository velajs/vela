# auth-lab-plugins

Demonstrates the **Pattern B** (DI'd plugin construction via `forRootAsync`) and
**Pattern C** (modular plugin feature modules) wiring shown in the
`@velajs/better-auth` README, with a runnable end-to-end smoke.

```bash
pnpm install
pnpm smoke      # 4 in-process checks
pnpm dev        # Node server on :8787
pnpm deploy     # wrangler deploy
```

## What's wired up

- **`MagicLinkAuthModule`** — a feature module that ships:
  - `EmailService` — a toy in-memory outbox (`@Injectable`)
  - `MAGIC_LINK_PLUGIN` token — provided via a factory that **injects
    `EmailService`** and returns `magicLink({ sendMagicLink: ... })` with the
    callback closed over the DI'd service
  - Exports both, so consumers can compose the plugin AND probe the outbox.

- **`AppModule`** — composes via `BetterAuthModule.forRootAsync`:
  - Imports `MagicLinkAuthModule`
  - Injects `MAGIC_LINK_PLUGIN` into the factory
  - Returns a `betterAuth({ ..., plugins: [magicLinkPlugin] })` instance to the
    module — the plugin is **constructed with vela's DI graph**, not stashed
    in a global.

## What the smoke proves

1. The public health route works (sanity).
2. `POST /api/auth/sign-in/magic-link` is registered (status != 404) — which
   only happens if the magicLink plugin was actually composed into the
   `betterAuth()` instance via the inject chain.
3. The `EmailService.outboxFor(email)` has at least one entry — proving the
   plugin's `sendMagicLink` callback closure resolved through DI, and the
   `EmailService` instance the plugin called is the SAME one the app
   container exposes (no parallel state).

## Scaling this pattern

A real ecosystem extension package — say `@velajs/better-auth-magic-link` —
ships exactly what `MagicLinkAuthModule` does:

- An `EmailService` interface and a default implementation
- A `MAGIC_LINK_PLUGIN` token
- A `Module` that wires them up

Consumers `import { MagicLinkAuthModule, MAGIC_LINK_PLUGIN }` and compose, no
glue code. Same shape for `OAuthAuthModule`, `TwoFactorAuthModule`,
`PasskeyAuthModule`, etc. — that's the "plug-in play" LEGO model.
