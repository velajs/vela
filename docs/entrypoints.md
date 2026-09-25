# Service entrypoints, email and tail

Every Worker event is a Vela entrypoint: it runs through the same guard, pipe,
interceptor and filter pipeline as an HTTP request, in its own execution scope.
Besides `fetch`, `queue`, `scheduled` ([Scheduling](scheduling.md)),
[Durable Objects](durable-objects.md) and [Workflows](workflows.md), a Worker
serves JS-RPC through named service entrypoints and receives Email Workers and
Tail Workers events.

## Service entrypoints

`VelaEntrypoint(app, Host, { rpc })` from `@velajs/cloudflare/entrypoints`
returns a `WorkerEntrypoint` class whose JS-RPC methods are the host methods
`rpc` names. Other Workers, and this one, call them through a service binding.

```ts
// src/billing/billing.host.ts
import { Inject, Injectable, UseGuards } from '@velajs/vela';
import { ENTRYPOINT_PROPS } from '@velajs/cloudflare/entrypoints';
import { InvoicesService } from '../invoices/invoices.service.js';
import { CallerGuard } from './caller.guard.js';

@UseGuards(CallerGuard)
@Injectable()
export class BillingHost {
  constructor(
    private readonly invoices: InvoicesService,
    @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
  ) {}

  async charge(customerId: string, cents: number): Promise<{ invoiceId: string }> {
    return this.invoices.charge(customerId, cents);
  }
}
```

```ts
// src/worker.ts
const app = defineCloudflareApp(AppModule);

export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
export default app.worker;
```

```jsonc
// The calling Worker's wrangler.jsonc
"services": [
  { "binding": "BILLING", "service": "billing-worker", "entrypoint": "Billing", "props": { "caller": "storefront" } }
]
```

```ts
// The calling Worker: Service<typeof Billing> once `wrangler types` ran.
const { invoiceId } = await env.BILLING.charge('customer-1', 500);
```

- Each call runs in the Worker's application for its environment, the same
  one the app's `fetch` handler and Workflows use, with the host added to the
  root module's providers. `VelaEntrypoint` takes the app from
  `defineCloudflareApp`; a bare root module is rejected. Declare the class at
  module scope of the module that defines the app.
- **RPC methods.** Exactly the host methods `rpc` names, and a
  `Service<typeof Billing>` binding exposes exactly their signatures. Nothing
  else is reachable over RPC, even from plain JavaScript naming it on a stub:
  not an unlisted public method, a TypeScript `private` helper, a lifecycle
  hook or `dispose()`. When the class is defined, each name must be a
  prototype method of the host. Hooks, `ctx`, `env`, `dup`, `then`, and the
  `WorkerEntrypoint` handlers (`fetch`, `connect`, `email`, `queue`,
  `scheduled`, `tail`, `tailStream`, `test`, `trace`) are rejected, and so is
  a host whose prototype defines `then()`.
- **Props.** `ENTRYPOINT_PROPS` injects the call's `ctx.props`: what the
  caller's service binding declares in `props`, or what a `ctx.exports`
  loopback stub passes (`exports.Billing({ props })`). It is `{}` when the
  caller attached none. It is request-scoped, so a class injecting it is built
  for each call; resolving it outside an RPC call throws. Validate it before
  use.
- **The pipeline.** Each call runs in its own execution scope through the
  host's scoped guards, pipes (the arguments, each with `{ type: 'custom' }`
  and its reflected parameter type), interceptors and filters.
  `ExecutionContext.getType()` is `'rpc'`, `getPayload()` the arguments.
  Application-wide `APP_*` components do not apply. A guard that returns
  `false` rejects the call with `403 forbidden`.
- **Errors.** A failure is reported first (`edge: 'rpc'`,
  `source: 'BillingHost.charge'`); the call rejects only with an
  `EntrypointError`, as a Durable Object RPC call does (see
  [Errors](#rpc-errors)). A claiming filter's non-undefined value becomes the
  call's result. When the application fails to start, the call rejects with a
  redacted `500` and the error is logged.

Type the RPC result as serializable data: `wrangler types` gives a method whose
result is not `Rpc.Serializable` (an `unknown` field, a class instance) the
type `never` on the stub.

## RPC errors

Durable Object hosts and service entrypoints reject a failed RPC call with an
`EntrypointError` from `@velajs/cloudflare`, rendered like an HTTP response
with server errors redacted: a 4xx `HttpException` or branded `VelaError` keeps
its `status`, `code`, `message` and `details`; anything else becomes
`500 internal "Internal Server Error"`. Its stack names only itself: no frame,
cause or other property of the original crosses the boundary.

```ts
import { isEntrypointError } from '@velajs/cloudflare';

try {
  await env.BILLING.charge('customer-1', 500);
} catch (error) {
  if (isEntrypointError(error) && error.status === 409) {
    // error.code, error.message, error.details
  }
}
```

workerd keeps an error's own properties across RPC from `compatibility_date`
2026-04-21, or with the `enhanced_error_serialization` flag. On an older date
the caller receives an `Error` whose message is `EntrypointError: <message>`,
without `status`, `code` or `details`, and `isEntrypointError()` is false;
`vela deploy check` warns with `rpc-error-serialization`. A host may throw an
`EntrypointError` itself, for example to pass on another entrypoint's failure:
a client fault keeps its code, message and details, a server fault only its
status.

## Email

`@OnEmail()` from `@velajs/cloudflare/email` makes a provider method an Email
Workers handler (entrypoint kind `cf:email`). It receives the native
`ForwardableEmailMessage`, which it can read (`raw`, `headers`, `rawSize`),
`forward()`, `reply()` or `setReject()`:

```ts
import { Injectable } from '@velajs/vela';
import { OnEmail } from '@velajs/cloudflare/email';

@Injectable()
export class SupportInbox {
  constructor(private readonly tickets: TicketsService) {}

  @OnEmail({ to: 'support@example.com' })
  async receive(message: ForwardableEmailMessage): Promise<void> {
    await this.tickets.open(message.from, message.headers.get('subject'));
    await message.forward('team@example.com');
  }

  @OnEmail()
  other(message: ForwardableEmailMessage): void {
    message.setReject('This address does not accept mail.');
  }
}
```

- Importing `OnEmail` gives the Worker (`app.worker`,
  `createCloudflareWorker()`) its `email` handler; a Worker whose code imports
  no `@OnEmail()` has none. Route the address to the Worker with Email
  Routing.
- A message goes to the handlers whose `to` lists its envelope recipient
  (`message.to`, compared without regard to case), else to the handlers
  without `to`. A message no handler accepts is rejected with
  `setReject('No handler accepts mail for this address.')`
  (`UNCLAIMED_EMAIL_REASON`), a permanent SMTP error for the sender, never
  silently dropped; the Worker logs a warning once unless diagnostics are
  silent.
- Each handler runs in its own execution scope, in the Worker's application,
  through its scoped guards, interceptors and filters (`getType()`
  `'cf:email'`, `getPayload()` the message); application-wide `APP_*`
  components do not apply. A failure is reported
  (`edge: 'email'`) and rethrown to the platform once every handler settled,
  unless a scoped filter handles it (a filter can call `setReject()` on
  `getPayload()`).

The message's `from` and `to` are the SMTP envelope; its headers are what the
sender claims. To read it as a parsed `InboundEmail` of `@velajs/mail` (bounded
header parse, the envelope, raw bytes for a MIME parser), call
`readInboundEmail(message)` from `@velajs/mail`. Its authentication stays
unverified unless you supply verdicts from a source you trust, so the mail
package's default DMARC gate refuses it.

## Tail

`@OnTail()` from `@velajs/cloudflare/tail` makes a provider method a Tail
Workers handler (entrypoint kind `cf:tail`), which receives each batch of
`TraceItem`s the producer Workers naming this one in `tail_consumers` emit:

```ts
import { Injectable } from '@velajs/vela';
import { OnTail } from '@velajs/cloudflare/tail';

@Injectable()
export class ExceptionTail {
  constructor(private readonly alerts: AlertsService) {}

  @OnTail()
  async observe(events: TraceItem[]): Promise<void> {
    const failed = events.filter((event) => event.outcome !== 'ok');
    if (failed.length > 0) await this.alerts.notify(failed);
  }
}
```

Importing `OnTail` gives the Worker its `tail` handler. Every `@OnTail()`
handler receives every batch, each in its own execution scope through its
scoped guards, interceptors and filters (`getType()` `'cf:tail'`);
application-wide `APP_*` components do not apply. A failure,
in a handler or around it, is reported (`edge: 'tail'`) and never thrown into
the platform's tail loop. When the application fails to start, there is no
`ExceptionHandler` to report through: the handler logs the error to the
console and resolves, and the next batch retries the start.

## Tests

`createTestingWorker()` from `@velajs/cloudflare/testing` drives the same
handlers: `worker.email(message)` and `worker.tail(events)`. `emailMessage()`
builds a `ForwardableEmailMessage` whose `setReject()`, `forward()` and
`reply()` are recorded on it (`rejectReason`, `forwards`, `replies`), and
`traceItem()` builds a `TraceItem`:

```ts
import { createTestingWorker, emailMessage, traceItem } from '@velajs/cloudflare/testing';

const worker = await createTestingWorker(AppModule);
const message = emailMessage({ from: 'ada@example.net', to: 'support@example.com', subject: 'Help' });
await worker.email(message);
expect(message.forwards).toEqual([{ rcptTo: 'team@example.com' }]);
await worker.tail([traceItem({ outcome: 'exception' })]);
await worker.close();
```

Call a service entrypoint in workerd through a binding to it, or through the
`ctx.exports` loopback: `import { exports } from 'cloudflare:workers'`, then
`await exports.Billing({ props }).charge(...)`.

## Tooling

- `vela g entrypoint billing` writes `billing.host.ts` and declares
  `export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['ping'] }) {}`
  in the Worker entry, after its app (defining the app first when the entry
  default-exports `createCloudflareWorker()`).
- `vela cf sync` warns about a service entrypoint class the app defines that
  the entry does not export, and about a service binding to this Worker whose
  `entrypoint` the entry does not export.
- `vela entrypoint list` lists exported Vela service entrypoints as
  `cf:entrypoint` rows with their RPC methods, and `@OnEmail()` and `@OnTail()`
  handlers as `cf:email` and `cf:tail` rows. `vela deploy check` warns with
  `unexported-entrypoint` and `rpc-error-serialization` (see
  [deployment](deployment.md)).
