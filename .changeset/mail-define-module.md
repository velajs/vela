---
'@velajs/mail': minor
---

Build `MailModule` on `defineModule` directly, with `queue` and `inbound` as its structural options (`MailStructuralOption`). The hand-written `forRoot`/`forRootAsync` wrappers and their process-wide reference-identity tables are removed; an inbound gate host still keys by the gate object.

**Behavior change:** a mailer's instance key comes from its structural options, so two configurations that differ only in `from`, `transport` or `render` share a key and the second is reported by the module loader instead of becoming another mailer. Give each additional mailer its own `key`. A `forRootAsync` factory that returns `queue` or `inbound` fails bootstrap with the engine's message (`MailModule.forRootAsync: the factory returned the structural option 'queue'`).
