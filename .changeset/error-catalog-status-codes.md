---
'@velajs/errors': minor
---

Add `not_acceptable` (406), `request_timeout` (408), `precondition_failed` (412) and
`precondition_required` (428) to the core catalog and `STATUS_TO_CODE`. Add
`codeForStatus(status)`, which returns the core code for a status and derives one for unmapped
statuses: an unmapped 4xx is `bad_request` and anything else is `internal`.

**Behavior change:** `toErrorBody` renders an unbranded error with a 4xx `fallbackStatus` that
has no catalog code as `bad_request` with the title `Bad Request` instead of `internal` with
`Internal Server Error`, and a 406, 408, 412 or 428 fallback now uses its new code and title.
