---
'@velajs/cli': patch
---

`vela client generate` accepts routes marked `@ApiExclude()`: they are left out of the contract instead of failing the check that every runtime route is documented.
