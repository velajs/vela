---
'@velajs/vela': minor
---

**Behavior change:** `REQUEST_CONTEXT.id` mirrors an inbound `x-request-id` header only when
it is 1–128 characters of `A-Z`, `a-z`, `0-9`, `.`, `_`, `:` or `-`. Any other value is
replaced by a generated UUID, so caller-supplied text cannot inject markup, quotes or
oversized values into logs and correlation fields.
