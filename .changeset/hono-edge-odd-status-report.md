---
'@velajs/vela': patch
---

A Hono `HTTPException` thrown past Vela's pipeline (from raw Hono middleware) with a fractional 4xx status, such as `404.5`, or a `NaN` status renders as a redacted 500 and is now reported first, like any other server fault. The raw `onError` edge used to skip reporting both, and the default reporter muted a fractional 4xx status as a client fault; both now treat only integer statuses from 400 to 499 as client faults. Other statuses the edge cannot answer, such as `302` or `700`, were already reported.
