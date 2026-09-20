---
"@velajs/studio-protocol": minor
"@velajs/studio-host": minor
"@velajs/studio": minor
"@velajs/studio-ui": minor
---

Introduce protocol-v2 local Studio sessions and execute API Explorer requests through
actual Worker HTTP after server authorization. Preserve custom mounts and isolate host,
admin and API credentials/cookies. Replace api.tryit with api.authorizeTryIt; remove the
host editable option and legacy window globals. Advertise only usable operations, accept
path/query/header inputs, and use request scope for Studio CRUD reads and single writes
while gating bulk actions on transaction support.

Validate every admin operation result with a shared concrete Zod parser before
exposing its associated response type. Reject malformed nested data, mismatched
operation envelopes and inconsistent error/HTTP statuses. Update Studio providers,
configuration, flag evaluation and optional time-travel module imports for the
typed core APIs.
