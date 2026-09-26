# @velajs/mail

Portable outbound mail and a trusted inbound dispatch seam for Vela. The package
keeps rendering, validation, message building, and delivery separate. It provides
optional SDK-free Resend and Cloudflare Email Service transports and a local mail catcher; applications can
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
| `@velajs/mail/transports/cloudflare` | `cloudflareEmailTransport({ binding })` and structural binding/payload types | No |
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

const mail = MailModule.register({
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

Use `registerAsync` with a typed application environment/configuration token when
credentials depend on the application. Dependencies are tuple-inferred from
`inject`; a factory without parameters may omit it:

```ts
import { InjectionToken } from '@velajs/vela';
import { MailModule } from '@velajs/mail';
import { resendTransport } from '@velajs/mail/transports/resend';

const Config = new InjectionToken<{ from: string; apiKey: string }>('mail-config');
// Application bootstrap must supply Config from its own validated environment.
const mail = MailModule.registerAsync({
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

Each `register` or `registerAsync` call owns a mailer with its own configuration. Reuse the returned dynamic module to share one mailer across feature imports. An explicit `key` is optional; reusing a key with different configuration fails bootstrap. Separate applications always own separate service instances. Consumers of multiple mailers should import the intended registration in separate feature modules; root `app.get(MailService)` is not a multi-mailer selector.

### Cloudflare Email Service

Use the native `send_email` binding with Email Service's transactional sending
API. This transport uses the structured builder overload of `SendEmail.send()`;
it does not use the older raw-MIME, verified-destination Email Routing recipe.
It requires no API token, SDK, Vela runtime, or `cloudflare:email` import itself.
The normal mail build/validation boundary still applies when calling `deliver`
directly with a `BuiltMessage`.

```ts
import { ENV } from '@velajs/vela';
import { MailModule } from '@velajs/mail';
import { cloudflareEmailTransport } from '@velajs/mail/transports/cloudflare';

// wrangler types declares EMAIL: SendEmail in Cloudflare.Env.
// Import @velajs/cloudflare in the Worker to type ENV from those bindings.
const mail = MailModule.registerAsync({
  inject: [ENV],
  useFactory: (env) => ({
    from: 'support@example.com',
    transport: cloudflareEmailTransport({ binding: env.EMAIL }),
    limits: { maxRecipients: 50 },
  }),
});
```

Configure `"send_email": [{ "name": "EMAIL" }]` in Wrangler, onboard the sending
domain to Email Service, and apply any required sender/recipient restrictions.
Construct the transport from each application's environment, as above. It retains
that binding and calls its method with the binding as receiver; no global binding
lookup or environment cache is used. See Cloudflare's [Workers sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
and [binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

The adapter preserves recipient roles and display names, both body alternatives
(including explicit empty strings), `replyTo`, and custom headers. It omits empty
CC/BCC lists and absent optional fields. It rejects more than 50 combined To/CC/BCC
entries before sending, including repeated entries; it never splits a message.
Set the mailer's recipient limit to 50 to reject oversized jobs before enqueue.
Cloudflare also enforces [message and header limits](https://developers.cloudflare.com/email-service/platform/limits/)
and its own [header allowlist](https://developers.cloudflare.com/email-service/reference/headers/).
Those provider rules can be stricter than Vela's guards. Headers are forwarded
unchanged, never silently dropped to satisfy the provider. Reserved Vela headers
remain reserved, including `In-Reply-To` and `References`. No attachment contract
or automatic reply threading is added.

A fulfilled send returns `{ provider: 'cloudflare', id: result.messageId }` when
the ID is a nonempty string, otherwise just the provider. Missing tracking data
does not manufacture a failure/retry after submission. This records a fulfilled
provider call, not recipient acceptance, inbox placement, or an exactly-once
guarantee; delivery has its own [lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/).
Rejected sends throw a fixed `MailError` with `code: 'provider_error'` and
`internal: true`. The original error, including native `.code`, remains only in
`cause` for server-side handling. The adapter does not retry. Queue redelivery
after an ambiguous failure or a crash after sending may submit the email again.

The [native Workers example](../../apps/mail-example/README.md#cloudflare-email-service-and-queued-responses)
composes `@OnEmail`, `MailService.queue()`, and the existing Cloudflare queue host.

## Queued delivery

```ts
import { QueueModule } from '@velajs/vela/queue';
import { cloudflareQueues } from '@velajs/cloudflare/queues';

@Module({
  imports: [
    QueueModule.forRoot({ driver: cloudflareQueues() }),
    MailModule.register({
      from: 'support@example.com',
      transport,
      queue: { name: 'mail', binding: 'MAIL_QUEUE' },
    }),
  ],
})
class AppModule {}

await mailer.queue({ to: 'user@example.com', subject: 'Digest', text: 'News' });
```

The mailer registers its queue with `QueueModule.forFeature([{ name, binding,
consumer }])` and its consumer as a `@Processor(name)`, so the application only
imports `QueueModule.forRoot({ driver })` once; a mailer with `queue` fails
bootstrap without it. `queue: {}` selects the default name `mail`. `binding` is
the producer binding the driver sends through (on Workers, a Wrangler
`queues.producers[].binding`) and `consumer` optionally pins the physical queue,
exactly as in `forFeature`. Queue names must be unique across mail
registrations in one application. Each registration has its own processor
class, preventing options from another mailer being selected by token
resolution. The service validates before enqueue; the consumer treats
`job.data` as unknown, reconstructs a fresh message, rebuilds its envelope, and
reruns validation and limits before delivery.

For `registerAsync`, `queue` stays beside `inject` and `useFactory` because it declares a processor. The factory returns outbound options and runtime `inbound: { gate }` policy. Gate contributions are discovered within each application: reusing one gate object is allowed, while distinct gates fail inbound dispatch. Policies are snapshotted when DI resolves them and cannot be relaxed by later caller mutation. The default still requires DMARC.

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
Application-wide `APP_*` pipeline components are not applied. Handler errors,
including those a scoped filter handles, are reported with `kind: 'mail:inbound'`
on the core `email` edge before the filters run; unclaimed errors are then
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
envelope. Pass transport envelope addresses through `options.envelope`.

## Testing and platform status

The catcher is an instance-local in-memory transport. Its `messages`, `clear`,
and `waitFor` methods support tests. `handler()` serves a JSON inbox, an HTML
viewer with `?format=html`, or clears messages on DELETE. Mount this viewer only
in local development; it has no authentication or persistence. Testing assertions
throw plain `Error` and have no test-framework dependency.

The portable runtime uses Web APIs. The Cloudflare transport accepts a structural
native binding without importing Workers runtime modules. Its workerd example
tests inbound `@OnEmail` routing, queued responses, environment isolation, invalid
jobs, and provider failures with native-shaped doubles. A separate test submits
to Wrangler's local `send_email` simulator (`remote: false`), without Node
compatibility or live sending. This verifies local runtime compatibility, not
production delivery. The Resend transport tests use injected fetch responses.
No SMTP transport or full MIME/attachment parser is implemented.

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
explicit async `inject` tuples, structural queue declarations, independent mailer registrations, runtime inbound policies, unique mail
queue names per app, and nonempty
authentication requirements. Public subpaths and `InboundEmail` are preserved.
Releases, catalogs, and lockfiles are owned by the monorepo root. The release
consumer checks every mail subpath from the packed archive outside the workspace,
including a framework-free installation.

## License

MIT
