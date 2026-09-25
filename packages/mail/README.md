# @velajs/mail

Portable outbound mail and a trusted inbound dispatch seam for Vela. The package
keeps rendering, validation, message building, and delivery separate. It provides
an optional SDK-free Resend transport and a local mail catcher; applications can
supply any `MailTransport`. No provider account is required.

## Install and exports

```sh
pnpm add @velajs/mail @velajs/vela
```

The Vela peer is optional at installation so standalone consumers can use the
framework-free subpaths. Install Vela when importing the main entry.

| Import | Supported API | Runtime Vela dependency |
| --- | --- | --- |
| `@velajs/mail` | Module/service, pipeline, address guards, raw rendering, inbound parsing/gating/dispatch, types/tokens | Yes |
| `@velajs/mail/transports/resend` | `resendTransport({ apiKey, baseUrl?, fetch? })` | No |
| `@velajs/mail/transports/catcher` | `createMailCatcher()` and capture types | No |
| `@velajs/mail/testing` | Catcher, `assertSent`, `assertNotSent`, `assertCount`, `lastMessage`, `extractLink`, `waitForMail` | No |

[Run the local support-inbox example](../../apps/mail-example/README.md) to exercise
inbound dispatch, a request-scoped handler, queued replies, and catcher assertions
without credentials or an external mail server.

## Outbound messages

```ts
import { Inject, Injectable, Module } from '@velajs/vela';
import { MailModule, MailService } from '@velajs/mail';
import { createMailCatcher } from '@velajs/mail/transports/catcher';

const mail = MailModule.forRoot({
  from: 'support@example.com',
  transport: createMailCatcher(),
  limits: { maxRecipients: 100, maxBodyBytes: 2 * 1024 * 1024 },
});

@Injectable()
class Notifications {
  constructor(@Inject(MailService) private readonly mailer: MailService) {}

  welcome(to: string) {
    return this.mailer.send({ to, subject: 'Welcome', text: 'Hello!' });
  }
}

@Module({ imports: [mail], providers: [Notifications] })
class AppModule {}
```

`MailMessage` accepts `from?`, required `to` and `subject`, optional `cc`, `bcc`,
`replyTo`, custom `headers`, `html`, `text`, and `template`. Address inputs may be a
bare address, `Name <address>`, or `{ email, name? }`; recipient fields also accept
arrays. At least one `to` recipient and a text or HTML body are required.

`send()` renders a template when present, validates all address/header fields,
builds the normalized `BuiltMessage`, then calls `transport.deliver(message)`.
The transport returns `{ id?, provider? }`. Custom transports and
`renderRawMessage()` expect already validated messages; calling them directly
with arbitrary objects bypasses the service's validation. Use `buildMessage()`
or `reparseBuiltWire()` at an untrusted message boundary.

Templates use a `render(input)` option returning `{ html?, text? }` synchronously
or asynchronously. Explicit message bodies win over rendered bodies. A template
without a renderer is an error. Vela does not provide an HTML/TSX renderer.

The pipeline rejects control characters, invalid address syntax, reserved custom
headers, and excessive recipient/header/body/message sizes. Default outbound
ceilings are 100 recipients, 50 custom headers, 64 KiB header values, 2 MiB bodies,
and 3 MiB approximate normalized message size. `limits` overrides must be positive
safe integers. These are resource ceilings, not a guarantee that a mail provider
will accept a message. Raw rendering supports text, HTML, and multipart alternative
bodies; it is not a complete MIME/attachment composer.

### Transport and environment configuration

Use `forRootAsync` with a typed application environment/configuration token when
credentials depend on the application. Dependencies are tuple-inferred from
`inject`; a factory without parameters may omit it:

```ts
import { InjectionToken } from '@velajs/vela';
import { MailModule } from '@velajs/mail';
import { resendTransport } from '@velajs/mail/transports/resend';

const Config = new InjectionToken<{ from: string; apiKey: string }>('mail-config');
// Application bootstrap must supply Config from its own validated environment.
const mail = MailModule.forRootAsync({
  imports: [ApplicationConfigModule],
  inject: [Config],
  useFactory: (config) => ({
    from: config.from,
    transport: resendTransport({ apiKey: config.apiKey }),
  }),
});
```

`ApplicationConfigModule` is an application module exporting `Config`. On Workers,
build it from the framework `ENV` (`inject: [ENV]`), which carries the Worker's
secrets; never cache per-environment credentials in a process-wide variable. The sample token is illustrative, not a framework token.

Alternatively, an application transport module can export a global
`{ provide: MAIL_TRANSPORT, useValue: transport }` provider. `MailService` prefers an
explicit `transport`, then that token. A missing transport fails at delivery with
`no_transport`, so producer-only queue workers can enqueue without one.

A mailer's instance key comes from its structural `queue` and `inbound` options
only. The same configuration imported twice deduplicates into one mailer. A
second configuration under the same key, such as another `from`, `transport` or
`render` with the same (or no) queue settings, fails bootstrap instead of
running on the first mailer's configuration. Give each additional mailer its own
distinct `key`: `MailModule.forRoot({ ..., key: 'marketing' })`. Keys are
per application, so separate applications can reuse one. Consumers of multiple
mailers should import the intended registration in separate feature modules;
root `app.get(MailService)` is not a multi-mailer selector.

## Queued delivery

```ts
import { QueueModule } from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';

@Module({
  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    MailModule.forRoot({
      from: 'support@example.com',
      transport,
      queue: { name: 'mail', binding: 'MAIL_QUEUE' },
    }),
  ],
})
class AppModule {}

await mailer.queue({ to: 'user@example.com', subject: 'Digest', text: 'News' });
```

The mailer registers its queue with `QueueModule.registerQueue({ name, binding,
consumer })` and its consumer as a `@Processor(name)`, so the application only
imports `QueueModule.forRoot({ driver })` once; a mailer with `queue` fails
bootstrap without it. `queue: {}` selects the default name `mail`. `binding` is
the producer binding the driver sends through (on Workers, a Wrangler
`queues.producers[].binding`) and `consumer` optionally pins the physical queue,
exactly as in `registerQueue`. Queue names must be unique across mail
registrations in one application. Each registration has its own processor
class, preventing options from another mailer being selected by token
resolution. The service validates before enqueue; the consumer treats
`job.data` as unknown, reconstructs a fresh message, rebuilds its envelope, and
reruns validation and limits before delivery.

For `forRootAsync`, `queue` and `inbound` are structural options alongside
`inject` and `useFactory`; returning them from the factory is rejected. The factory
returns only outbound options (`from`, `transport?`, `render?`, `limits?`).

The default core queue driver is in-memory. Durable delivery requires a platform
queue driver such as `cloudflareQueues()`, whose native deliveries reach the
mailer's consumer like any other processor. Mail does not implement retries,
delivery idempotency, or exactly-once delivery; a retried job can send twice.
Transport failures propagate to the driver/host, which retries the job.

## Inbound email

```ts
import { Injectable } from '@velajs/vela';
import { OnInboundEmail, type InboundEmail } from '@velajs/mail';

@Injectable()
class SupportInbox {
  @OnInboundEmail({ match: (email) => email.envelope?.to === 'support@example.com' })
  async receive(email: InboundEmail): Promise<void> {
    // Resolve application identity/tenant policy before authorizing work.
  }
}
```

Register the handler as a provider. An outbound `MailModule` is not needed for
inbound-only applications. A trusted host adapter parses raw data and invokes:

```ts
const email = parseInboundEmail(raw, {
  envelope: { from: smtpFrom, to: smtpTo },
  verifiedAuthentication: trustedAdapterVerdicts,
});
const result = await dispatchInboundEmail(app.getContainer(), app.entrypoints, email);
```

Use the container and registry from the same application. Dispatch evaluates the
application gate before routing, then invokes each matching handler once per
owning module with its own request scope. Handlers and class/method guards,
interceptors, and exception filters resolve in that module. Context exposes the
owning module ID and current scope. All invocations finish and dispose before
dispatch returns or rejects, including lazy dependencies and failure paths.
Application-wide `APP_*` pipeline components are not applied. Unclaimed errors
are reported with `kind: 'mail:inbound'` on the core `email` edge, then
propagated to the host. The result is `{ gated, handled, failed }`.

### Email Workers messages

`readInboundEmail(message, options?)` reads a platform inbound message (the
SMTP envelope `from` and `to`, a raw `ReadableStream` and its `rawSize`), such
as the `ForwardableEmailMessage` an `@OnEmail()` handler of
`@velajs/cloudflare/email` receives, into an `InboundEmail`. It refuses a
declared size over `limits.maxMessageBytes` before reading, cancels a longer
stream, and parses the bytes with the SMTP envelope as `envelope`:

```ts
import { OnEmail } from '@velajs/cloudflare/email';
import { readInboundEmail } from '@velajs/mail';

@Injectable()
class SupportInbox {
  @OnEmail({ to: 'support@example.com' })
  async receive(message: ForwardableEmailMessage): Promise<void> {
    const email = await readInboundEmail(message);
    // email.envelope, email.subject, email.headers, email.raw() for a MIME parser
  }
}
```

The options are `parseInboundEmail`'s, less `envelope`. Nothing verifies the
sender unless you pass `verifiedAuthentication` from a source you trust (or
`trustedAuthservIds` under the conditions below), so the default gate refuses
such a message.

### Authentication gate

The default requires DMARC `pass`. A custom gate may require DKIM, SPF, DMARC, or
several mechanisms, with an additional synchronous `policy(auth, email)` that must
return exactly `true`. Empty requirements are rejected. Every required verdict
must equal `pass`; missing, failing, or unknown verdicts fail closed.

Configure `inbound: { gate }` on `MailModule`, or register
`{ provide: MAIL_INBOUND_GATE, useValue: gate }` in an inbound-only app.
Module-supplied gates are snapshotted at registration. More than one distinct
registered gate rejects dispatch; compose application policies into one gate.
The gate and transport belong to their application, not a shared registration map.

Raw `Authentication-Results` headers are untrusted by default. Prefer verified
verdicts supplied out of band by the receiving service. `trustedAuthservIds` is
supported only when the adapter controls the receiving MTA and guarantees that
its topmost header was added by that MTA, stripping spoofed claims. Matching an
ID string alone does not authenticate arbitrary raw mail. Only the topmost header
is considered; all such headers are removed from public `email.headers`.
Do not accept `verifiedAuthentication` from an untrusted HTTP request.

The visible `from` is spoofable. DMARC authenticates a domain, not an application
user or tenant. `match` routes already gated mail; it is not authorization.

### Parsing and the Agent contract

`parseInboundEmail(raw, options?)` accepts a string, `Uint8Array`, or `ArrayBuffer`.
It parses top-level headers only, unfolds continuations, uses lowercase last-wins
header names, and enforces limits (25 MiB message, 64 KiB headers, 200 headers,
100 recipients by default). Recipient splitting is a simple comma split, not a
full RFC mailbox-list parser. Use the trusted SMTP envelope for delivery routing.
Use a MIME parser on `raw()` for bodies/attachments.

`InboundEmail` retains its exported contract: `from: string`, `to: string[]`,
optional `subject`, `messageId`, `inReplyTo`, `references`, a `headers` record,
`authentication: { dkim, spf, dmarc }`, `authenticationSource` (`adapter`,
`authserv-id`, or `none`), optional `envelope: { from, to }`, `raw(): Uint8Array`,
and `rawText(): string`. The parser snapshots input bytes and the validated
envelope. The legacy second-argument `{ from, to }` envelope form remains accepted.

## Testing and platform status

The catcher is an instance-local in-memory transport. Its `messages`, `clear`,
and `waitFor` methods support tests. `handler()` serves a JSON inbox, an HTML
viewer with `?format=html`, or clears messages on DELETE. Mount this viewer only
in local development; it has no authentication or persistence. Testing assertions
throw plain `Error` and have no test-framework dependency.

The portable runtime uses Web APIs. No native Cloudflare send-email adapter,
SMTP transport, or full MIME parser is implemented in this monorepo. A Worker
receives Email Workers messages through `@OnEmail()` handlers of
`@velajs/cloudflare/email`, which read them with `readInboundEmail()`; the
dispatch seam can be wired by an application host, but native Email Workers
behavior is not claimed or tested by this package. The Resend transport uses fetch; tests exercise injected responses,
not a live provider account.

`MailError` exposes `code`, `internal`, optional `status`, and `cause`. Codes include
`invalid_address`, `invalid_header`, `invalid_message`, `no_transport`,
`queue_required`, `render_failed`, `provider_error`, `inbound_malformed`, and
`inbound_rejected`. Provider failures use a fixed public message with details in
`cause`; do not serialize server-side causes to clients. Module configuration and
application handler errors can also be ordinary `Error` instances.

## Migration and release ownership

Source, tests, MIT license, and changelog were retained from the standalone
`velajs/mail` repository (source commit `775785542a9d40eb7dfce9913d6fb71fdef48d56`).
The standalone checkout remains untouched. npm returned E404 for `@velajs/mail`
on 2026-09-21; the package retains source version 1.0.0 with a pending root changeset.

Intentional 1.x integration changes: use checked `defineProvider` descriptors,
explicit async `inject` tuples, structural queue/inbound options, instance keys
from those structural options (another mailer takes its own `key`), unique mail
queue names per app, and nonempty
authentication requirements. Public subpaths and `InboundEmail` are preserved.
Releases, catalogs, and lockfiles are owned by the monorepo root. The release
consumer checks every mail subpath from the packed archive outside the workspace,
including a framework-free installation.

## License

MIT
