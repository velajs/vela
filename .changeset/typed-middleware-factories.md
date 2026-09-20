---
'@velajs/cloudflare': major
---

Build middleware with `middleware: env => [...]` so callbacks capture the same typed native environment registered in DI. The raw Hono context exposes opaque bindings and unknown variables, and request containers use the core scope accessor. Entrypoint metadata is validated before dispatch.
