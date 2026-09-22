---
'@velajs/studio': patch
---

Refuse admin RPC and `/ws-token` requests whose body is not sent as `application/json` (or a
`+json` media type) with a 415 `unsupported_media_type` error envelope. Requests without a body
are dispatched as before.
