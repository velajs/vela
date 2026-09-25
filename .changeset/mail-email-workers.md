---
'@velajs/mail': minor
---

`readInboundEmail(message, options?)` reads a platform inbound message (the SMTP envelope `from` and `to`, the raw `ReadableStream` and its `rawSize`), such as the `ForwardableEmailMessage` an `@OnEmail()` handler of `@velajs/cloudflare/email` receives, into an `InboundEmail`. A declared size over `limits.maxMessageBytes` is refused before reading and a longer stream is cancelled (`inbound_malformed`); the bytes are parsed by `parseInboundEmail` with the SMTP envelope as `envelope`. The options are `parseInboundEmail`'s less `envelope` (`ReadInboundEmailOptions`), and the message type is `InboundEmailMessage`. Authentication stays unverified unless the options supply trusted verdicts, so the default gate refuses such a message.

**Behavior change:** an `@OnInboundEmail` handler failure, including one a scoped filter handles, is reported on the core `'email'` edge (`ErrorReportContext.edge`) instead of `'queue'`; `kind` stays `'mail:inbound'`. An `ExceptionHandler` that filters inbound mail failures by `edge === 'queue'` must match `'email'`.
