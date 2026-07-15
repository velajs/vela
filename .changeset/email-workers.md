---
"@velajs/cloudflare": minor
---

Add Cloudflare Email Workers adapters over `@velajs/mail`'s edge-neutral core.

- **Outbound** — `CloudflareEmailModule.forRoot({ binding })` (default `SEND_EMAIL`) provides `@velajs/mail`'s `MAIL_TRANSPORT` as a **global** token, so a `MailModule.forRoot({ from })` in another module resolves the transport across module boundaries. The transport (`createCloudflareEmailTransport`) reads the `send_email` binding lazily from a `BindingRef` (auto-initialized by the existing adapter binding-init path), assembles RFC 822 bytes with `renderRawMessage` **above** the transport seam, and constructs one `EmailMessage` (`cloudflare:email`) per envelope recipient (single-recipient binding → fan-out). Provider errors are redacted to a fixed `MailError('provider_error', …, { internal: true })`; the raw platform error rides `MailError.cause` only.
- **Inbound** — an `email()` host hook on `CloudflareApplication` (sibling of `queue()`/`scheduled()`). It reads the RAW byte stream (NOT `message.headers`, which collapses duplicate `Authentication-Results` and would let an attacker-injected lower header win), parses via `@velajs/mail`'s CF-free `parseInboundEmail` with the SMTP envelope, and dispatches through `dispatchInboundEmail`. Gating is fail-closed (default DMARC=pass): when the gate fails, no handler runs and the hook replies `setReject` with a fixed generic reason (never internal detail). The `mail:inbound` `EntrypointKind` and `@OnInboundEmail` decorator are declared in `@velajs/mail`; this package only adapts `ForwardableEmailMessage` and re-exports the inbound authoring surface (`OnInboundEmail`, `InboundEmail`, `MailInboundGate`) for one-import DX.

Adds `@velajs/mail` as a peer dependency, a `cloudflare:email` test shim + vitest alias, and a `@velajs/vela` dedupe so the linked local `@velajs/mail` and this package share one vela copy under test.
