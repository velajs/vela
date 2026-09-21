---
'@velajs/rpc': patch
---

Validate RPC route paths with linear boundary, separator and character checks, avoiding excessive regex backtracking on long invalid paths. Preserve concrete absolute paths with nonempty ASCII identifier segments and reject trailing or repeated slashes and disallowed characters.
