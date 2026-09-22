---
'@velajs/errors': minor
---

Add `not_acceptable` (406), `request_timeout` (408), `precondition_failed` (412) and
`precondition_required` (428) to the core catalog. Add `codeForStatus(status)`, which
returns the core code for a status and derives one for unmapped statuses: an unmapped
4xx is `bad_request` and anything else is `internal`. A `toErrorBody` fallback status
now uses that code and its title, so an unbranded error with a 4xx fallback reports
`bad_request` instead of `internal`.
