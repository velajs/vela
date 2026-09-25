---
'@velajs/mail': minor
---

Add the framework-free `transports/cloudflare` subpath for outbound Cloudflare
Email Service bindings. Preserve structured recipients, bodies, reply-to and
custom headers, redact provider failures while retaining their cause, and return
submission tracking metadata without promising recipient delivery. Include a
local Workers example composing native inbound email with existing queued mail.
