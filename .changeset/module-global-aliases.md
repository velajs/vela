---
'@velajs/vela': patch
---

Preserve `APP_*` useExisting registrations as aliases, including their declaring
module and inspectable target metadata. Global aliases retain singleton identity
and request reuse, and now correctly resolve transient targets freshly instead
of accidentally caching them in a synthetic singleton factory. Use an explicit
singleton target when shared global state is intended.
