---
'@velajs/storage': patch
---

Call the platform `fetch` without a receiver in the S3 client. Under workerd, invoking the global `fetch` as a method of the client made every S3 and R2-over-HTTP operation fail with "Illegal invocation" (Node was unaffected). A Workers-runtime test now covers the default fetch.
