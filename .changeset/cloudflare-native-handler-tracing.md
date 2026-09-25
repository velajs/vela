---
'@velajs/cloudflare': patch
---

Add the optional `/tracing` entrypoint with `CloudflareTracingInterceptor` for
native Workers spans around awaited HTTP and service RPC handler work. Span
names are fixed and labels contain only bounded class and method names.
