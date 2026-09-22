---
"@velajs/better-auth": patch
---

`BetterAuthModule.forRoot({ key })` and `forRootAsync({ key })` no longer throw when a root is rebuilt with the same explicit key in one isolate, for example per Worker environment or per Durable Object. Within an application, the same registration still deduplicates, and a registration with a different auth instance, factory or options becomes its own module instance.
