---
'@velajs/studio': patch
---

Report caught admin RPC errors once through the configured application logger and exception policy, preserving invocation correlation while keeping raw error details out of the client response.
