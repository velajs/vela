---
'@velajs/studio': minor
---

Read admin RPC and `/ws-token` request bodies with `readJsonBody` from `@velajs/vela`.

**Behavior change:** admin RPC and `/ws-token` requests whose body is not sent as
`application/json` (or a `+json` media type) are refused with a 415 `unsupported_media_type`
error envelope instead of being parsed as JSON, so a cross-site form or `text/plain` POST never
reaches an admin operation. Requests without a body are dispatched as before. Custom Studio
clients must send `content-type: application/json`.
