---
'@velajs/storage': patch
---

Call the platform `fetch` without a receiver in the S3 client. On workerd, every S3 and R2-over-HTTP request made through the default `fetch` failed with "Illegal invocation" because the client invoked it as one of its own methods; Node accepted the call, so only Workers deployments were affected. A Workers-runtime test now covers the default transport.
