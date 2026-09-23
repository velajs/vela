---
"@velajs/cli": patch
---

`vela client generate` no longer fails with `OpenAPI is missing ALL ...` on an application with an `@All` route, such as the Better Auth catch-all handler. OpenAPI has no operation for `ALL`, so the check that the document covers every application route now skips those routes, as the document itself does.
