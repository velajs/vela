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
implement an SMTP server. The authentication
verdicts are fixture data, not verification of a real email.

## Cloudflare Email Service and queued responses

The separate [Worker](cloudflare/worker.ts) receives native email with the existing
`@OnEmail()` decorator, reads it with `readInboundEmail()`, and enqueues a response
through `MailService.queue()`. `MailModule` owns its mail processor and queue
registration; the root selects `cloudflareQueues()` once. The existing Worker
host handles both email and queue events. No extra email host, processor, queue
subscription adapter, or transport DI module is needed.

`MailModule.forRootAsync` constructs `cloudflareEmailTransport({ binding: env.EMAIL })`
using the typed environment injected before provider construction. The transport
maps messages to the transactional Email Service structured sending API, including
To/CC/BCC, named addresses, both bodies, reply-to and allowed custom headers.
Sending requires an onboarded Email Service domain and appropriate binding
restrictions; this example's addresses are synthetic placeholders. See the
[transport guide](../../packages/mail/README.md#cloudflare-email-service).

The example responds only to `REPLY_RECIPIENT` from configuration. It never uses
untrusted inbound From/Reply-To as authorization or fabricates authentication
verdicts from raw headers. A production application must resolve and authorize its
own reply recipient and suppress unwanted automatic responses. `@OnEmail` does
native routing; it does not invoke the separate `OnInboundEmail` authentication
gate. This queued response is a fresh outbound email with `replyTo` set to the
support mailbox, not native `message.reply()` or an automatically threaded reply.

Run locally from the repository root:

```sh
pnpm --filter vela-mail-example... build
pnpm --filter vela-mail-example types:workers
pnpm --filter vela-mail-example typecheck
pnpm --filter vela-mail-example test:workers
pnpm --filter vela-mail-example exec wrangler deploy --dry-run --config cloudflare/wrangler.jsonc
```

Tests run in workerd without `nodejs_compat`. Native-shaped binding doubles prove
email → queue → send composition, cross-environment isolation, recipient/header
guards at producer and consumer boundaries, and unacknowledged provider failures.
Redelivery is tested explicitly: the same successful job can send twice. The
transport does not provide idempotency or retry policy.

One test uses the actual local `send_email` simulator with structured recipients,
bodies, headers and reply-to. [Wrangler configuration](cloudflare/wrangler.jsonc)
sets `remote: false`; no live email or cloud resources are used by these checks.
The simulator does not prove production acceptance or delivery. Cloudflare's
[local sending guide](https://developers.cloudflare.com/email-service/local-development/sending/)
describes simulation and remote binding behavior. No deployment or domain
administration is part of this example's verification.
