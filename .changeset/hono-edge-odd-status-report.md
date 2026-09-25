---
'@velajs/vela': patch
---

A Hono `HTTPException` thrown past Vela's pipeline (from raw Hono middleware) with a status the error edge cannot answer, such as a fractional `404.5`, `NaN` or `700`, renders as a redacted 500 and is now reported first, like any other server fault. The raw `onError` edge used to skip reporting any status between 400 and 499 that was not an integer, and the default reporter muted it as a client fault; both now treat only integer statuses from 400 to 499 as client faults.
