---
'@velajs/vela': minor
---

Add `readJsonBody(c, { maxBytes? })`, the JSON body reader used by `@Body()` and
`defineEndpoint` `json` groups, for routes registered directly on Hono.

**Behavior change:** JSON bodies must be sent as `application/json` or a `+json` media type
such as `application/vnd.api+json` (parameters like `charset` are allowed). Any other body,
including one with no `Content-Type`, is rejected with 415 `unsupported_media_type` instead of
being parsed as JSON, so a cross-site `text/plain` or form-encoded POST can no longer reach a
JSON handler without a CORS preflight. Requests without a body still resolve `@Body()` to
`undefined`. Send `content-type: application/json` from clients and tests that post JSON.
