---
'@velajs/agent': patch
---

Publish the `@velajs/mail` peer range the repository declares: `^1.31.0`, the release that builds `MailModule` on `defineModule`. @velajs/agent 1.28.1 was published with `^1.29.0`, while later releases raised the range in the repository without publishing it. Install @velajs/mail 1.31.0 or later with this version. The agent imports only mail's `InboundEmail` type and has no other changes.
