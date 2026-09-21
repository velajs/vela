# Mail pipeline example

Run from the monorepo root with Node 24+ and pnpm 11.11.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter vela-mail-example... build
pnpm --filter vela-mail-example start
```

This local example dispatches a simulated authenticated inbound email to a
request-scoped support handler in its owning module, queues a reply, and flushes
the in-memory queue into a mail catcher. It checks the captured reply and disposes
the application. It needs no credentials and sends no external messages.

Use [the mail package guide](../../packages/mail/README.md) to replace the catcher
with a transport or supply a trusted inbound adapter. This example does not
implement a Cloudflare `email()` host hook or an SMTP server. The authentication
verdicts are fixture data, not verification of a real email.
