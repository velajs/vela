---
'@velajs/storage': minor
---

Read the storage HTTP control plane's request bodies with `readJsonBody` from `@velajs/vela`
in `/sign-upload`, `/sign-download`, `/delete` and the `/multipart/*` endpoints.

**Behavior change:** these endpoints refuse a body that is not `application/json` or a `+json`
media type with 415 and `{ error: { code: 'invalid_request', message } }`, before the
authorizer runs. Previously a cross-site `text/plain` POST, which browsers send without a CORS
preflight, was parsed as JSON, so a page on another origin could make a cookie-authenticated
user delete or sign objects. Malformed JSON and a missing or non-object body are now 400
`invalid_request` instead of 502 `upstream_error` or 400 `invalid_key`. The
`@velajs/storage/client` browser client already sends `application/json`.
