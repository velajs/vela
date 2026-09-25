---
'@velajs/cli': patch
---

`vela client generate` leaves routes marked `@ApiExclude()` out of the generated contract, as the OpenAPI document does, and still checks that every other runtime route is documented.
